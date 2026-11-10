import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { VcsProcessOutputLimitError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { buildDeltaPlan, discoverFiles, findRepoRoot, hashFile } from "./discovery.ts";

const layerTest = Layer.mergeAll(WorkspacePaths.layer, VcsProcess.layer).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const output = (
  stdout: string,
  exitCode = 0,
  stdoutTruncated = false,
): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(exitCode),
  stdout,
  stderr: "",
  stdoutTruncated,
  stderrTruncated: false,
});

const noGit = VcsProcess.VcsProcess.of({ run: () => Effect.succeed(output("", 128)) });

const write = Effect.fn("knowledge.test.write")(function* (
  root: string,
  relPath: string,
  text: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absPath = path.join(root, relPath);
  yield* fs.makeDirectory(path.dirname(absPath), { recursive: true });
  yield* fs.writeFileString(absPath, text);
});

describe("Knowledge discovery", () => {
  it.live(
    "enumerates tracked paths from the canonical root and walks fully on real output overflow",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const vcs = yield* VcsProcess.VcsProcess;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-knowledge-git-" });
        const root = path.join(directory, "repo");
        yield* fs.makeDirectory(root);
        const tracked = ["tracked.ts", "name with space.ts", "line\nbreak.ts"];
        for (const file of [...tracked, "untracked.ts", ".repos/reference.ts"]) {
          yield* write(root, file, "export const value = 1;");
        }
        yield* fs.makeDirectory(path.join(root, "nested"));
        const git = (args: ReadonlyArray<string>) =>
          vcs.run({
            operation: "Knowledge.test.git",
            command: "git",
            cwd: root,
            args,
          });
        yield* git(["init"]);
        yield* git(["add", "--", ...tracked, ".repos/reference.ts"]);
        const alias = path.join(directory, "alias");
        yield* fs.symlink(root, alias);
        const canonical = yield* fs.realPath(root);
        expect(yield* findRepoRoot(path.join(alias, "nested"))).toBe(canonical);
        const result = yield* discoverFiles(path.join(root, "nested"));
        expect(result.root).toBe(canonical);
        expect(result.files.map((file) => file.relPath)).toEqual([...tracked].sort());
        expect(result.files.every((file) => file.size === 23)).toBe(true);

        const overflowing = VcsProcess.VcsProcess.of({
          run: (input) =>
            vcs.run(input.args.includes("ls-files") ? { ...input, maxOutputBytes: 8 } : input),
        });
        const fallback = yield* discoverFiles(root).pipe(
          Effect.provideService(VcsProcess.VcsProcess, overflowing),
        );
        expect(fallback.files.map((file) => file.relPath)).toEqual(
          [...tracked, "untracked.ts"].sort(),
        );
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect.each(["failure", "overflow", "truncation"] as const)(
    "falls back to the complete directory tree after Git %s",
    (failure) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-knowledge-fallback-" });
        for (const file of ["first.ts", "nested/deep/last.ts", ".git/ignored.ts"]) {
          yield* write(root, file, "text");
        }
        const vcs = VcsProcess.VcsProcess.of({
          run: (input) => {
            if (input.args.includes("rev-parse")) return Effect.succeed(output(`${root}\n`));
            if (failure === "overflow")
              return Effect.fail(
                new VcsProcessOutputLimitError({
                  operation: input.operation,
                  command: input.command,
                  cwd: input.cwd,
                  stream: "stdout",
                  maxBytes: 8,
                  observedBytes: 9,
                }),
              );
            return Effect.succeed(
              failure === "truncation" ? output("first.ts\0nested/", 0, true) : output("", 128),
            );
          },
        });
        const result = yield* discoverFiles(root).pipe(
          Effect.provideService(VcsProcess.VcsProcess, vcs),
        );
        expect(result.files.map((file) => file.relPath)).toEqual([
          "first.ts",
          "nested/deep/last.ts",
        ]);
        expect(result.files[1]?.absPath).toBe(path.join(root, "nested", "deep", "last.ts"));
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("keeps a successful empty Git index empty", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-knowledge-empty-" });
      yield* fs.makeDirectory(path.join(root, ".git"));
      yield* write(root, "untracked.ts", "not tracked");
      const vcs = VcsProcess.VcsProcess.of({
        run: (input) => Effect.succeed(output(input.args.includes("rev-parse") ? `${root}\n` : "")),
      });
      const result = yield* discoverFiles(root).pipe(
        Effect.provideService(VcsProcess.VcsProcess, vcs),
      );
      expect(result.files).toEqual([]);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("replaces includes, extends segment/suffix excludes, and filters the text sample", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-knowledge-filters-" });
      for (const file of [
        "src/file.ts",
        "src/file.min.ts",
        "src/directory.min.ts/keep.ts",
        "src/scratch/file.ts",
        "docs/README.MD",
        "src/file.cxx",
        "src/file.hxx",
        "src/file.c",
        "src/file.mjs",
        "src/file.cjs",
        ".env",
        "src/file.png",
        ...[".repos", "node_modules", "dist", "build", "coverage", "logs", "vendor", ".git"].map(
          (dir) => `${dir}/hidden.ts`,
        ),
      ])
        yield* write(root, file, "plain text");
      yield* write(root, "src/binary.ts", "text\0binary");
      yield* write(root, "src/late-nul.ts", `${"x".repeat(2048)}\0`);
      const defaults = yield* discoverFiles(root);
      expect(defaults.files.map((file) => file.relPath)).toEqual([
        "docs/README.MD",
        "src/directory.min.ts/keep.ts",
        "src/file.c",
        "src/file.cjs",
        "src/file.min.ts",
        "src/file.mjs",
        "src/file.ts",
        "src/late-nul.ts",
        "src/scratch/file.ts",
      ]);
      const custom = yield* discoverFiles(root, {
        includes: ["ts"],
        excludes: ["*.min.ts", "scratch", "src/**"],
      });
      expect(custom.files.map((file) => file.relPath)).toEqual([
        "src/directory.min.ts/keep.ts",
        "src/file.ts",
        "src/late-nul.ts",
      ]);
      const markdown = yield* discoverFiles(root, { includes: ["md"], excludes: [] });
      expect(markdown.files.map((file) => file.relPath)).toEqual(["docs/README.MD"]);
      const explicit = yield* discoverFiles(root, { includes: ["cxx", "hxx"], excludes: [] });
      expect(explicit.files.map((file) => file.relPath)).toEqual(["src/file.cxx", "src/file.hxx"]);
    }).pipe(
      Effect.provideService(VcsProcess.VcsProcess, noGit),
      Effect.provide(layerTest),
      Effect.scoped,
    ),
  );

  it.effect.each(["git", "walk"] as const)("keeps %s discovery inside the resolved root", (mode) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-knowledge-links-" });
      const root = path.join(directory, "repo");
      yield* write(root, "inside.ts", "inside");
      yield* write(directory, "outside.ts", "outside");
      yield* write(directory, "outside/secret.ts", "secret");
      yield* fs.symlink(path.join(root, "inside.ts"), path.join(root, "inside-link.ts"));
      yield* fs.symlink(path.join(directory, "outside.ts"), path.join(root, "outside-link.ts"));
      yield* fs.symlink(path.join(directory, "outside"), path.join(root, "external"));
      yield* fs.symlink(root, path.join(root, "cycle"));
      yield* fs.makeDirectory(path.join(root, ".git"));
      const vcs = VcsProcess.VcsProcess.of({
        run: (input) =>
          Effect.succeed(
            mode === "walk"
              ? output("", 128)
              : output(
                  input.args.includes("rev-parse")
                    ? `${root}\n`
                    : "inside.ts\0inside-link.ts\0outside-link.ts\0external/secret.ts\0../outside.ts\0",
                ),
          ),
      });
      const result = yield* discoverFiles(root).pipe(
        Effect.provideService(VcsProcess.VcsProcess, vcs),
      );
      expect(result.files.map((file) => file.relPath)).toEqual(
        mode === "git" ? ["inside-link.ts", "inside.ts"] : ["inside.ts"],
      );
      expect(result.files.every((file) => file.absPath === path.join(root, "inside.ts"))).toBe(
        true,
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("reports unavailable roots and hashes the actual file bytes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-knowledge-hash-" });
      const missing = yield* findRepoRoot(path.join(root, "missing")).pipe(Effect.flip);
      expect(missing.code).toBe("source_unavailable");
      yield* write(root, "hello.txt", "hello");
      expect(yield* hashFile(path.join(root, "hello.txt"))).toBe(
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      );
      const unreadable = yield* hashFile(path.join(root, "missing")).pipe(Effect.flip);
      expect(unreadable.code).toBe("file_read_failed");
    }).pipe(
      Effect.provideService(VcsProcess.VcsProcess, noGit),
      Effect.provide(layerTest),
      Effect.scoped,
    ),
  );
});

describe("Knowledge delta", () => {
  it("sorts added/changed/deleted/unchanged files and leaves an intact re-ingest unchanged", () => {
    const file = (relPath: string, fileHash: string) => ({
      absPath: `/repo/${relPath}`,
      relPath,
      fileHash,
      ext: "ts",
      size: 1,
    });
    const previous = [
      file("z-unchanged.ts", "same"),
      file("b-deleted.ts", "old"),
      file("a-changed.ts", "before"),
      file("a-deleted.ts", "old"),
    ];
    const discovered = [
      file("z-unchanged.ts", "same"),
      file("b-added.ts", "new"),
      file("a-changed.ts", "after"),
      file("a-added.ts", "new"),
      file("a-added.ts", "new"),
    ];
    const delta = buildDeltaPlan({ previous, discovered });
    expect(delta.added.map((entry) => entry.relPath)).toEqual(["a-added.ts", "b-added.ts"]);
    expect(delta.changed).toEqual([file("a-changed.ts", "after")]);
    expect(delta.deleted.map((entry) => entry.relPath)).toEqual(["a-deleted.ts", "b-deleted.ts"]);
    expect(delta.unchanged).toEqual([file("z-unchanged.ts", "same")]);
    const repeated = buildDeltaPlan({ previous: discovered, discovered });
    expect(repeated.added).toEqual([]);
    expect(repeated.changed).toEqual([]);
    expect(repeated.deleted).toEqual([]);
    expect(repeated.unchanged.map((entry) => entry.relPath)).toEqual([
      "a-added.ts",
      "a-changed.ts",
      "b-added.ts",
      "z-unchanged.ts",
    ]);
    expect(previous[0]?.relPath).toBe("z-unchanged.ts");
    expect(discovered[0]?.relPath).toBe("z-unchanged.ts");
  });
});
