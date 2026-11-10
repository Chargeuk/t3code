// @effect-diagnostics nodeBuiltinImport:off -- SHA-256 matches the existing file/chunk hash format.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { KnowledgeOperationError } from "../../../../packages/contracts/src/knowledge.ts";
import { splitNullSeparatedGitStdoutPaths } from "../vcs/GitVcsDriverCore.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { isWithinRoot } from "../workspace/KnownWorkspaces.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import type { KnowledgeDiscoveredFile, KnowledgeFileFilters } from "./types.ts";

export const defaultFileFilters: KnowledgeFileFilters = {
  includes: [
    "ts",
    "tsx",
    "js",
    "jsx",
    "mjs",
    "cjs",
    "json",
    "jsonc",
    "md",
    "mdx",
    "txt",
    "py",
    "java",
    "kt",
    "kts",
    "go",
    "rs",
    "rb",
    "php",
    "cs",
    "cpp",
    "cc",
    "c",
    "h",
    "hpp",
    "swift",
    "scala",
    "clj",
    "cljs",
    "edn",
    "sh",
    "bash",
    "zsh",
    "ps1",
    "yaml",
    "yml",
    "toml",
    "ini",
    "cfg",
    "env",
    "sql",
  ],
  excludes: ["node_modules", ".git", "dist", "build", "coverage", "logs", "vendor", ".repos"],
};

export type IndexedFile = { readonly relPath: string; readonly fileHash: string };
export type DiscoveredFileHash = KnowledgeDiscoveredFile & { readonly fileHash: string };
export type DeltaPlan = {
  readonly unchanged: ReadonlyArray<IndexedFile>;
  readonly changed: ReadonlyArray<DiscoveredFileHash>;
  readonly added: ReadonlyArray<DiscoveredFileHash>;
  readonly deleted: ReadonlyArray<IndexedFile>;
};

const matchesExclude = (relPath: string, excludes: ReadonlyArray<string>) => {
  const segments = relPath.split("/");
  const base = segments.at(-1) ?? "";
  return excludes.some((pattern) => {
    if (!pattern) return false;
    return pattern.includes("*")
      ? base.endsWith(pattern.replace(/^\*/, ""))
      : segments.includes(pattern);
  });
};

export const findRepoRoot = Effect.fn("Knowledge.findRepoRoot")(function* (startPath: string) {
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const fs = yield* FileSystem.FileSystem;
  const vcs = yield* VcsProcess.VcsProcess;
  const normalized = yield* workspacePaths
    .normalizeWorkspaceRoot(startPath)
    .pipe(
      Effect.mapError(
        (cause) => new KnowledgeOperationError({ code: "source_unavailable", cause }),
      ),
    );
  const result = yield* vcs
    .run({
      operation: "Knowledge.findRepoRoot",
      command: "git",
      args: ["-c", "core.fsmonitor=false", "rev-parse", "--show-toplevel"],
      cwd: normalized,
      outputMode: "error",
      allowNonZeroExit: true,
    })
    .pipe(Effect.orElseSucceed(() => undefined));
  const gitRoot = result?.stdout.replace(/\r?\n$/, "");
  const root =
    result?.exitCode === 0 && !result.stdoutTruncated && !result.stdoutInvalidUtf8 && gitRoot
      ? gitRoot
      : normalized;
  return yield* fs
    .realPath(root)
    .pipe(
      Effect.mapError(
        (cause) => new KnowledgeOperationError({ code: "source_unavailable", cause }),
      ),
    );
});

export const discoverFiles = Effect.fn("Knowledge.discoverFiles")(function* (
  startPath: string,
  filters?: KnowledgeFileFilters,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcs = yield* VcsProcess.VcsProcess;
  const root = yield* findRepoRoot(startPath);
  const includes = filters?.includes.length ? filters.includes : defaultFileFilters.includes;
  const excludes = [...new Set([...defaultFileFilters.excludes, ...(filters?.excludes ?? [])])];
  const hasGit = yield* fs
    .exists(path.join(root, ".git"))
    .pipe(
      Effect.mapError((cause) => new KnowledgeOperationError({ code: "discovery_failed", cause })),
    );
  const gitResult = hasGit
    ? yield* vcs
        .run({
          operation: "Knowledge.discoverFiles",
          command: "git",
          args: ["-c", "core.fsmonitor=false", "ls-files", "--cached", "-z"],
          cwd: root,
          outputMode: "error",
          allowNonZeroExit: true,
        })
        .pipe(Effect.orElseSucceed(() => undefined))
    : undefined;
  let relPaths: string[];
  if (gitResult?.exitCode === 0 && !gitResult.stdoutTruncated && !gitResult.stdoutInvalidUtf8) {
    relPaths = splitNullSeparatedGitStdoutPaths(gitResult);
  } else {
    relPaths = [];
    const directories = [root];
    const excludedSegments = excludes.filter((pattern) => !pattern.includes("*"));
    while (directories.length > 0) {
      const directory = directories.pop()!;
      const entries = yield* fs
        .readDirectoryEntries(directory)
        .pipe(
          Effect.mapError(
            (cause) => new KnowledgeOperationError({ code: "discovery_failed", cause }),
          ),
        );
      for (const entry of entries) {
        const absPath = path.join(directory, entry.name);
        const relPath = path.relative(root, absPath).split(path.sep).join("/");
        if (matchesExclude(relPath, excludedSegments)) continue;
        let type = entry.type;
        if (type === "Unknown") {
          const link = yield* fs.readLink(absPath).pipe(Effect.orElseSucceed(() => undefined));
          if (link !== undefined) continue;
          type = (yield* fs
            .stat(absPath)
            .pipe(
              Effect.mapError(
                (cause) => new KnowledgeOperationError({ code: "discovery_failed", cause }),
              ),
            )).type;
        }
        if (type === "Directory") directories.push(absPath);
        else if (type === "File") relPaths.push(relPath);
      }
    }
  }

  const files: KnowledgeDiscoveredFile[] = [];
  for (const relPath of [...new Set(relPaths)].sort()) {
    if (matchesExclude(relPath, excludes)) continue;
    const ext = path.extname(relPath).slice(1).toLowerCase();
    if (!includes.includes(ext)) continue;
    const absPath = yield* fs
      .realPath(path.resolve(root, relPath))
      .pipe(Effect.orElseSucceed(() => undefined));
    if (absPath === undefined || !isWithinRoot(path, absPath, root)) continue;
    const stat = yield* fs.stat(absPath).pipe(Effect.orElseSucceed(() => undefined));
    if (stat?.type !== "File") continue;
    const isText = yield* Effect.gen(function* () {
      const file = yield* fs.open(absPath, { flag: "r" });
      const buffer = new Uint8Array(2048);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const count = yield* file.read(buffer.subarray(bytesRead));
        if (count === 0) break;
        bytesRead += count;
      }
      return !buffer.subarray(0, bytesRead).includes(0);
    }).pipe(
      Effect.scoped,
      Effect.orElseSucceed(() => false),
    );
    if (isText) files.push({ absPath, relPath, ext, size: Number(stat.size) });
  }
  return { root, files };
});

export const hashFile = Effect.fn("Knowledge.hashFile")(function* (absPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const bytes = yield* fs
    .readFile(absPath)
    .pipe(
      Effect.mapError((cause) => new KnowledgeOperationError({ code: "file_read_failed", cause })),
    );
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
});

const byRelPath = (a: IndexedFile, b: IndexedFile) => a.relPath.localeCompare(b.relPath);

export function buildDeltaPlan(params: {
  readonly previous: ReadonlyArray<IndexedFile>;
  readonly discovered: ReadonlyArray<DiscoveredFileHash>;
}): DeltaPlan {
  const previous = new Map(params.previous.map((file) => [file.relPath, file]));
  const discovered = new Map<string, DiscoveredFileHash>();
  for (const file of [...params.discovered].sort(byRelPath)) {
    if (!discovered.has(file.relPath)) discovered.set(file.relPath, file);
  }
  const unchanged: IndexedFile[] = [];
  const changed: DiscoveredFileHash[] = [];
  const added: DiscoveredFileHash[] = [];
  for (const file of discovered.values()) {
    const before = previous.get(file.relPath);
    if (!before) added.push(file);
    else if (before.fileHash !== file.fileHash) changed.push(file);
    else unchanged.push(before);
  }
  const deleted = params.previous.filter((file) => !discovered.has(file.relPath));
  return {
    unchanged: unchanged.sort(byRelPath),
    changed: changed.sort(byRelPath),
    added: added.sort(byRelPath),
    deleted: deleted.sort(byRelPath),
  };
}
