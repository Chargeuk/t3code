import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { SecretProviderId } from "@t3tools/contracts";
import { SecretResolver } from "@t3tools/secret-provider-core/server/SecretResolver";
import { ChromaNotFoundError, type Where } from "chromadb";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { ChildProcessSpawner } from "effect/process";
import { vi } from "vite-plus/test";

import * as Knowledge from "../../../../packages/contracts/src/knowledge.ts";
import migration from "../persistence/Migrations/081_RepositoryKnowledge.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Settings from "../serverSettings.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as Repository from "./KnowledgeRepository.ts";
import { RepositoryKnowledge } from "./RepositoryKnowledge.ts";
import * as Live from "./RepositoryKnowledgeLive.ts";
import * as Discovery from "./discovery.ts";
import * as Deterministic from "./embeddings/DeterministicEmbeddings.ts";
import * as Embeddings from "./embeddings/EmbeddingModels.ts";

type VectorRow = {
  id: string;
  document: string;
  metadata: Record<string, string | number>;
  embedding: number[];
};
const sdk = vi.hoisted(() => ({
  rows: new Map<string, VectorRow>(),
  exists: false,
  failDelete: false,
  get: vi.fn(),
  query: vi.fn(),
  upsert: vi.fn(),
  delete: vi.fn(),
  count: vi.fn(),
  getCollection: vi.fn(),
  getOrCreateCollection: vi.fn(),
  deleteCollection: vi.fn(),
}));
vi.mock("chromadb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("chromadb")>();
  return {
    ...actual,
    ChromaClient: class {
      getCollection = sdk.getCollection;
      getOrCreateCollection = sdk.getOrCreateCollection;
      deleteCollection = sdk.deleteCollection;
    },
  };
});

function matches(where: Where, metadata: VectorRow["metadata"]): boolean {
  if ("$and" in where && Array.isArray(where.$and))
    return where.$and.every((term: Where) => matches(term, metadata));
  if ("$or" in where && Array.isArray(where.$or))
    return where.$or.every((term: Where) => matches(term, metadata));
  return Object.entries(where).every(([key, value]) => {
    if (typeof value === "object" && value !== null && "$in" in value && Array.isArray(value.$in))
      return value.$in.includes(metadata[key]);
    return value === metadata[key];
  });
}

function setup() {
  sdk.rows.clear();
  sdk.exists = false;
  sdk.failDelete = false;
  for (const value of Object.values(sdk)) if (typeof value === "function") value.mockReset();
  const collection = {
    get: sdk.get,
    query: sdk.query,
    upsert: sdk.upsert,
    delete: sdk.delete,
    count: sdk.count,
  };
  sdk.getCollection.mockImplementation(async () => {
    if (!sdk.exists) throw new ChromaNotFoundError("absent");
    return collection;
  });
  sdk.getOrCreateCollection.mockImplementation(async () => {
    sdk.exists = true;
    return collection;
  });
  sdk.deleteCollection.mockImplementation(async () => {
    if (sdk.failDelete) throw new Error("delete response unavailable");
    sdk.rows.clear();
    sdk.exists = false;
  });
  sdk.count.mockImplementation(async () => sdk.rows.size);
  sdk.get.mockImplementation(async ({ where }: { where: Where }) => {
    const rows = [...sdk.rows.values()].filter((row) => matches(where, row.metadata));
    return {
      ids: rows.map((row) => row.id),
      documents: rows.map((row) => row.document),
      metadatas: rows.map((row) => row.metadata),
    };
  });
  sdk.delete.mockImplementation(async ({ where }: { where: Where }) => {
    for (const row of sdk.rows.values()) if (matches(where, row.metadata)) sdk.rows.delete(row.id);
  });
  sdk.upsert.mockImplementation(
    async (input: {
      ids: string[];
      embeddings: number[][];
      documents: string[];
      metadatas: VectorRow["metadata"][];
    }) => {
      for (let index = 0; index < input.ids.length; index += 1) {
        const row = {
          id: input.ids[index]!,
          embedding: input.embeddings[index]!,
          document: input.documents[index]!,
          metadata: input.metadatas[index]!,
        };
        sdk.rows.set(row.id, row);
      }
    },
  );
  sdk.query.mockImplementation(
    async ({
      where,
      queryEmbeddings,
      nResults,
    }: {
      where: Where;
      queryEmbeddings: number[][];
      nResults: number;
    }) => {
      const rows = [...sdk.rows.values()]
        .filter((row) => matches(where, row.metadata))
        .map((row) => ({
          row,
          distance: row.embedding.reduce(
            (sum, value, index) => sum + (value - queryEmbeddings[0]![index]!) ** 2,
            0,
          ),
        }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, nResults);
      return {
        ids: [rows.map(({ row }) => row.id)],
        documents: [rows.map(({ row }) => row.document)],
        metadatas: [rows.map(({ row }) => row.metadata)],
        distances: [rows.map(({ distance }) => distance)],
      };
    },
  );
  const calls: string[][] = [];
  let beforeEmbed: ((texts: ReadonlyArray<string>) => Effect.Effect<void>) | undefined;
  const embeddingLayer = Layer.effect(
    Embeddings.EmbeddingModels,
    Effect.gen(function* () {
      const delegate = yield* Embeddings.EmbeddingModels;
      return Embeddings.EmbeddingModels.of({
        discover: delegate.discover,
        resolve: Effect.fn("Knowledge.test.resolve")(function* (
          ...input: Parameters<typeof delegate.resolve>
        ) {
          const model = yield* delegate.resolve(...input);
          return {
            ...model,
            embedBatch: Effect.fn("Knowledge.test.embed")(function* (texts: ReadonlyArray<string>) {
              calls.push([...texts]);
              if (beforeEmbed) yield* beforeEmbed(texts);
              return yield* model.embedBatch(texts);
            }),
          };
        }),
      });
    }),
  ).pipe(Layer.provide(Deterministic.layer));
  const database = Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      if (
        (yield* sql`SELECT name FROM sqlite_schema WHERE name = 'knowledge_sources'`).length === 0
      )
        yield* migration;
    }),
  ).pipe(Layer.provideMerge(Sqlite.layerMemory));
  const secretReads: unknown[] = [];
  const dependencies = Layer.mergeAll(
    Repository.layer.pipe(Layer.provideMerge(database)),
    WorkspacePaths.layer,
    embeddingLayer,
    Settings.ServerSettingsService.layerTest({ knowledge: { embedding: fixtureSelection } }),
    Layer.succeed(
      SecretResolver,
      SecretResolver.of({
        read: (references) =>
          Effect.sync(() => {
            secretReads.push(...references);
            return references.map(() => undefined);
          }),
        invalidate: () => Effect.void,
        label: () => Effect.succeed("Test vault"),
      }),
    ),
    Layer.succeed(
      VcsProcess.VcsProcess,
      VcsProcess.VcsProcess.of({
        run: () =>
          Effect.succeed({
            exitCode: ChildProcessSpawner.ExitCode(128),
            stdout: "",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
      }),
    ),
  ).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));
  return {
    dependencies,
    calls,
    secretReads,
    beforeEmbed: (hook: typeof beforeEmbed) => {
      beforeEmbed = hook;
    },
  };
}

const fixtureSelection: Knowledge.KnowledgeEmbeddingSelection = {
  provider: "lmstudio",
  model: Deterministic.fixtureModels[0].model,
};
const secondSelection: Knowledge.KnowledgeEmbeddingSelection = {
  provider: "lmstudio",
  model: Deterministic.fixtureModels[1].model,
};
const write = Effect.fn("Knowledge.test.write")(function* (
  root: string,
  relPath: string,
  text: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(path.join(root, relPath)), { recursive: true });
  yield* fs.writeFileString(path.join(root, relPath), text);
});
const open = Effect.fn("Knowledge.test.open")(function* () {
  return Context.get(yield* Layer.build(Layer.fresh(Live.layer)), RepositoryKnowledge);
});
const observeRun = Effect.fn("Knowledge.test.observeRun")(function* (
  service: RepositoryKnowledge["Service"],
  runId: Knowledge.KnowledgeRunId,
  predicate: (run: Knowledge.KnowledgeRunSummary) => boolean,
) {
  const snapshot = yield* service.subscribe({}).pipe(
    Stream.filter((value) =>
      value.sources.some(
        (source) => source.latestRun?.runId === runId && predicate(source.latestRun),
      ),
    ),
    Stream.runHead,
  );
  assert.equal(snapshot._tag, "Some");
});

it.effect(
  "keeps active input stable, updates queued input in FIFO order and waits through queue time",
  () => {
    const state = setup();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "knowledge-queue-" });
      const path = yield* Path.Path;
      const roots = [path.join(root, "a"), path.join(root, "b"), path.join(root, "c")];
      for (const directory of roots)
        yield* write(directory, "README.md", Deterministic.fixtureTexts[0]);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      state.beforeEmbed(() =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      );
      const service = yield* open();
      const settings = yield* Settings.ServerSettingsService;
      const first = (yield* service.admit({ target: { root: roots[0]! } })).run;
      yield* Deferred.await(entered);
      yield* settings.updateSettings({ knowledge: { embedding: secondSelection } });
      const activeDuplicate = (yield* service.admit({ target: { sourceId: first.sourceId } })).run;
      assert.equal(activeDuplicate.runId, first.runId);
      assert.deepEqual(activeDuplicate.embedding, fixtureSelection);
      const second = (yield* service.admit({ target: { root: roots[1]! } })).run;
      const third = (yield* service.admit({ target: { root: roots[2]! } })).run;
      yield* settings.updateSettings({ knowledge: { embedding: fixtureSelection } });
      const replacement = (yield* service.admit({ target: { root: roots[1]! } })).run;
      assert.equal(replacement.runId, second.runId);
      assert.equal(replacement.admissionOrder, second.admissionOrder);
      assert.equal(replacement.queuePosition, 1);
      assert.equal(third.queuePosition, 2);
      assert.deepEqual(replacement.embedding, fixtureSelection);
      const wait = yield* service.waitTerminal({ runId: second.runId }).pipe(Effect.forkChild);
      assert.isFalse((yield* service.cancel({ runId: second.runId })).applied);
      const removal = yield* service.remove({ sourceId: second.sourceId }).pipe(Effect.result);
      assert.equal(removal._tag, "Failure");
      yield* Deferred.succeed(release, undefined);
      assert.equal((yield* service.waitTerminal({ runId: first.runId })).status, "completed");
      assert.equal((yield* Fiber.join(wait)).status, "completed");
      assert.equal((yield* service.waitTerminal({ runId: third.runId })).status, "failed");
      const snapshot = yield* service.list({});
      assert.equal(
        snapshot.sources.find((source) => source.sourceId === third.sourceId)?.latestRun?.error
          ?.code,
        "embedding_unavailable",
      );
      assert.equal(state.calls.length, 2);
    }).pipe(Effect.provide(state.dependencies), Effect.scoped);
  },
);

it.effect(
  "integrates delta/no-op, full AST replacement, scoped queries and removal while retaining repository files",
  () => {
    const state = setup();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "knowledge-delta-" });
      yield* write(root, "alpha.ts", "export function alpha() { return 1; }\n");
      yield* write(
        root,
        "beta.ts",
        "import { alpha } from './alpha';\nfunction local() { return alpha(); }\nexport function beta() { return local(); }\n",
      );
      const service = yield* open();
      const first = (yield* service.admit({ target: { root } })).run;
      assert.equal((yield* service.waitTerminal({ runId: first.runId })).status, "completed");
      const initialCalls = state.calls.length;
      assert.isAbove(initialCalls, 0);
      const initialAst = yield* service.astListSymbols({ sourceId: first.sourceId });
      const alpha = (yield* service.astFindDefinition({
        sourceId: first.sourceId,
        selector: { name: "alpha", kind: "Function" },
      })).symbol;
      assert.equal(alpha?.range.start.line, 1);
      assert.isNotNull(alpha);
      const references = yield* service.astFindReferences({
        sourceId: first.sourceId,
        selector: { name: "alpha" },
      });
      assert.isAbove(references.references.length, 0);
      assert.deepEqual(
        yield* service.astFindReferences({
          sourceId: first.sourceId,
          selector: { symbolId: alpha!.symbolId },
        }),
        references,
      );
      assert.deepEqual(
        (yield* service.astFindReferences({
          sourceId: first.sourceId,
          selector: { symbolId: "unknown-symbol" },
        })).references,
        [],
      );
      const beta = (yield* service.astFindDefinition({
        sourceId: first.sourceId,
        selector: { name: "beta" },
      })).symbol;
      assert.isNotNull(beta);
      const calls = yield* service.astCallGraph({
        sourceId: first.sourceId,
        symbolId: beta!.symbolId,
        depth: 2,
      });
      assert.isAbove(calls.edges.length, 0);
      assert.isTrue(
        calls.edges.every((edge) => edge.sourceId === first.sourceId && edge.type === "CALLS"),
      );
      assert.equal(
        (yield* service.astModuleImports({ sourceId: first.sourceId, relPath: "beta.ts" }))
          .modules[0]?.imports[0]?.source,
        "./alpha",
      );
      const noop = (yield* service.admit({ target: { sourceId: first.sourceId } })).run;
      const noopTerminal = yield* service.waitTerminal({ runId: noop.runId });
      assert.equal(noopTerminal.counts.unchangedFiles, 2);
      assert.equal(noopTerminal.counts.embeddedChunks, 0);
      assert.equal(state.calls.length, initialCalls);
      assert.deepEqual(
        (yield* service.astListSymbols({ sourceId: first.sourceId })).symbols,
        initialAst.symbols,
      );
      yield* write(root, "README.md", "Repository notes.");
      const prose = (yield* service.admit({ target: { sourceId: first.sourceId } })).run;
      yield* service.waitTerminal({ runId: prose.runId });
      assert.deepEqual(
        (yield* service.astListSymbols({ sourceId: first.sourceId })).symbols,
        initialAst.symbols,
      );
      yield* write(root, "beta.ts", "export function broken( {");
      const invalid = (yield* service.admit({ target: { sourceId: first.sourceId } })).run;
      const failure = yield* service.waitTerminal({ runId: invalid.runId });
      assert.equal(failure.status, "failed");
      assert.equal(failure.error?.code, "ast_parse_failed");
      assert.equal(failure.error?.relPath, "beta.ts");
      assert.deepEqual(
        (yield* service.astListSymbols({ sourceId: first.sourceId })).symbols,
        initialAst.symbols,
      );
      yield* fs.remove(path.join(root, "alpha.ts"));
      yield* write(root, "beta.ts", "export function gamma() { return 3; }\n");
      const changed = (yield* service.admit({ target: { sourceId: first.sourceId } })).run;
      const done = yield* service.waitTerminal({ runId: changed.runId });
      assert.equal(done.status, "completed");
      assert.equal(done.counts.deletedFiles, 1);
      assert.equal(done.counts.changedFiles, 1);
      assert.equal(
        (yield* service.astFindDefinition({
          sourceId: first.sourceId,
          selector: { name: "alpha" },
        })).symbol,
        null,
      );
      assert.equal(
        (yield* service.astFindDefinition({
          sourceId: first.sourceId,
          selector: { name: "gamma" },
        })).symbol?.runId,
        changed.runId,
      );
      const otherRoot = yield* fs.makeTempDirectoryScoped({ prefix: "knowledge-other-" });
      yield* write(otherRoot, "README.md", Deterministic.fixtureTexts[1]);
      const other = (yield* service.admit({ target: { root: otherRoot } })).run;
      yield* service.waitTerminal({ runId: other.runId });
      const result = yield* service.retrieve({
        sourceIds: [first.sourceId],
        query: "gamma",
        limit: 10,
      });
      assert.isAbove(result.matches.length, 0);
      assert.isTrue(result.matches.every(({ chunk }) => chunk.sourceId === first.sourceId));
      assert.isFalse(
        [...sdk.rows.values()].some(
          (row) => row.metadata.sourceId === first.sourceId && row.metadata.relPath === "alpha.ts",
        ),
      );
      const removed = (yield* service.remove({ sourceId: first.sourceId })).run;
      yield* service.waitTerminal({ runId: removed.runId });
      assert.isTrue(yield* fs.exists(path.join(root, "beta.ts")));
      assert.equal((yield* service.resolve({ root })).source?.sourceId, first.sourceId);
      assert.isFalse(
        [...sdk.rows.values()].some((row) => row.metadata.sourceId === first.sourceId),
      );
      assert.isNotNull((yield* service.list({})).embeddingIdentity);
      assert.equal(
        (yield* service.astListSymbols({ sourceId: first.sourceId }).pipe(Effect.result))._tag,
        "Failure",
      );
      const final = (yield* service.remove({ sourceId: other.sourceId })).run;
      yield* service.waitTerminal({ runId: final.runId });
      assert.isNull((yield* service.list({})).embeddingIdentity);
      assert.equal(sdk.rows.size, 0);
      assert.isTrue(yield* fs.exists(path.join(otherRoot, "README.md")));
    }).pipe(Effect.provide(state.dependencies), Effect.scoped);
  },
);

it.effect.each(["added", "changed", "unchanged"] as const)(
  "keeps %s file hashes, AST and vectors associated when an editor saves during ingestion",
  (classification) => {
    const state = setup();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "knowledge-edit-" });
      const original = "export function versionA() { return 1; }\n";
      yield* write(root, "a.ts", "export const first = 1;\n");
      if (classification !== "added")
        yield* write(
          root,
          "z.ts",
          classification === "unchanged" ? original : "export const old = 0;\n",
        );
      const service = yield* open();
      const baseline = (yield* service.admit({ target: { root } })).run;
      assert.equal((yield* service.waitTerminal({ runId: baseline.runId })).status, "completed");
      yield* write(root, "a.ts", "export const first = 2;\n");
      yield* write(root, "z.ts", original);
      const editedBytes = new Uint8Array([
        ...new TextEncoder().encode("export function versionB() { return 2; }\n// café "),
        255,
      ]);
      state.beforeEmbed((texts) =>
        texts.some((text) => text.includes("const first = 2"))
          ? fs.writeFile(path.join(root, "z.ts"), editedBytes).pipe(Effect.orDie)
          : Effect.void,
      );
      const changed = (yield* service.admit({ target: { root } })).run;
      assert.equal((yield* service.waitTerminal({ runId: changed.runId })).status, "completed");
      const fileHash = yield* Discovery.hashFile(path.join(root, "z.ts"));
      const repository = yield* Repository.KnowledgeRepository;
      assert.equal(
        (yield* repository.files(baseline.sourceId)).find((file) => file.relPath === "z.ts")
          ?.fileHash,
        fileHash,
      );
      const rows = [...sdk.rows.values()].filter((row) => row.metadata.relPath === "z.ts");
      assert.isAbove(rows.length, 0);
      assert.isTrue(
        rows.every(
          (row) => row.document.includes("versionB") && row.metadata.fileHash === fileHash,
        ),
      );
      const ast = yield* service.astFindDefinition({
        sourceId: baseline.sourceId,
        selector: { name: "versionB" },
      });
      assert.equal(ast.symbol?.fileHash, fileHash);
      state.beforeEmbed(undefined);
      yield* write(root, "z.ts", original);
      const restored = (yield* service.admit({ target: { root } })).run;
      const done = yield* service.waitTerminal({ runId: restored.runId });
      assert.equal(done.status, "completed");
      assert.equal(done.counts.changedFiles, 1);
      assert.equal(done.counts.embeddedChunks, 1);
      assert.isTrue(
        [...sdk.rows.values()]
          .filter((row) => row.metadata.relPath === "z.ts")
          .every((row) => row.document.includes("versionA")),
      );
    }).pipe(Effect.provide(state.dependencies), Effect.scoped);
  },
);

it.effect("cancels an in-flight embedding, rejects its late result and preserves live AST", () => {
  const state = setup();
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "knowledge-cancel-" });
    yield* write(root, "earlier.ts", "export const earlier = 1;\n");
    yield* write(root, "index.ts", "export function before() { return 1; }\n");
    yield* write(root, "deleted.ts", "export const deleted = 1;\n");
    yield* write(root, "stable.ts", "export const stable = 1;\n");
    const service = yield* open();
    const first = (yield* service.admit({ target: { root } })).run;
    yield* service.waitTerminal({ runId: first.runId });
    const ast = yield* service.astListSymbols({ sourceId: first.sourceId });
    const started = yield* Deferred.make<void>();
    const late = Promise.withResolvers<void>();
    const delivered = Promise.withResolvers<void>();
    state.beforeEmbed((texts) => {
      if (!texts.some((text) => text.includes("function after"))) return Effect.void;
      const pending = late.promise.then(() => delivered.resolve());
      return Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.promise(() => pending)),
      );
    });
    yield* write(root, "index.ts", "export function after() { return 2; }\n");
    yield* write(root, "earlier.ts", "export const earlier = 2;\n");
    const path = yield* Path.Path;
    yield* fs.remove(path.join(root, "deleted.ts"));
    const active = (yield* service.admit({ target: { sourceId: first.sourceId } })).run;
    yield* Deferred.await(started);
    const upserts = sdk.upsert.mock.calls.length;
    assert.isTrue((yield* service.cancel({ runId: active.runId })).applied);
    assert.equal((yield* service.waitTerminal({ runId: active.runId })).status, "cancelled");
    yield* Effect.sync(() => late.resolve());
    yield* Effect.promise(() => delivered.promise);
    assert.equal(sdk.upsert.mock.calls.length, upserts);
    assert.deepEqual(
      (yield* service.astListSymbols({ sourceId: first.sourceId })).symbols,
      ast.symbols,
    );
    assert.isFalse((yield* service.cancel({ runId: active.runId })).applied);
    const repository = yield* Repository.KnowledgeRepository;
    assert.deepEqual(
      (yield* repository.files(first.sourceId)).map((file) => file.relPath),
      ["stable.ts"],
    );
    yield* write(root, "earlier.ts", "export const earlier = 1;\n");
    yield* write(root, "index.ts", "export function before() { return 1; }\n");
    yield* write(root, "deleted.ts", "export const deleted = 1;\n");
    state.beforeEmbed(undefined);
    const retry = (yield* service.admit({ target: { sourceId: first.sourceId } })).run;
    const completed = yield* service.waitTerminal({ runId: retry.runId });
    assert.equal(completed.status, "completed");
    const survivingChunks = [...sdk.rows.values()].filter(
      (row) => row.metadata.sourceId === first.sourceId,
    ).length;
    assert.equal(survivingChunks, 4);
    assert.equal(completed.counts.unchangedFiles, 1);
    assert.equal(completed.counts.embeddedChunks, 3);
    assert.equal(completed.counts.chunks, survivingChunks);
    assert.equal(
      (yield* service.resolve({ sourceId: first.sourceId })).source?.chunkCount,
      survivingChunks,
    );
    assert.isNotNull(
      (yield* service.astFindDefinition({ sourceId: first.sourceId, selector: { name: "before" } }))
        .symbol,
    );
  }).pipe(Effect.provide(state.dependencies), Effect.scoped);
});

it.effect.each(["before-vector", "after-vector"] as const)(
  "recovers the same abandoned run at %s and never replays committed terminal work",
  (boundary) => {
    const state = setup();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "knowledge-recover-" });
      yield* write(root, "README.md", Deterministic.fixtureTexts[0]);
      const scope = yield* Scope.fork(yield* Effect.scope);
      const service = Context.get(
        yield* Layer.buildWithScope(Live.layer, scope),
        RepositoryKnowledge,
      );
      const baseline = (yield* service.admit({ target: { root } })).run;
      assert.equal((yield* service.waitTerminal({ runId: baseline.runId })).status, "completed");
      assert.equal((yield* service.resolve({ sourceId: baseline.sourceId })).source?.chunkCount, 1);
      yield* write(root, "README.md", Deterministic.fixtureTexts[2]);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const delivered = Promise.withResolvers<void>();
      if (boundary === "before-vector") {
        state.beforeEmbed(() =>
          Effect.promise(() => {
            entered.resolve();
            return release.promise.then(() => delivered.resolve());
          }),
        );
      } else {
        const writeVectors = sdk.upsert.getMockImplementation()!;
        sdk.upsert.mockImplementationOnce(async (...input) => {
          await writeVectors(...input);
          entered.resolve();
          await release.promise;
          delivered.resolve();
        });
      }
      const admitted = (yield* service.admit({ target: { root } })).run;
      const runId = admitted.runId;
      yield* Effect.promise(() => entered.promise);
      const closing = yield* Scope.close(scope, Exit.void).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.sync(() => release.resolve());
      yield* Fiber.join(closing);
      yield* Effect.promise(() => delivered.promise);
      const repository = yield* Repository.KnowledgeRepository;
      assert.equal((yield* repository.getRun(runId)).status, "running");
      assert.deepEqual(yield* repository.files(baseline.sourceId), []);
      assert.equal(sdk.rows.size > 0, boundary === "after-vector");
      yield* write(root, "README.md", Deterministic.fixtureTexts[0]);
      state.beforeEmbed(undefined);
      const recoveredScope = yield* Scope.fork(yield* Effect.scope);
      const recoveredService = Context.get(
        yield* Layer.buildWithScope(Layer.fresh(Live.layer), recoveredScope),
        RepositoryKnowledge,
      );
      const done = yield* recoveredService.waitTerminal({ runId });
      assert.equal(done.status, "completed");
      assert.equal(done.runId, admitted.runId);
      assert.equal(done.admissionOrder, admitted.admissionOrder);
      assert.equal(sdk.rows.size, 1);
      const survivingChunks = [...sdk.rows.values()].filter(
        (row) => row.metadata.sourceId === admitted.sourceId,
      ).length;
      assert.equal(done.counts.chunks, survivingChunks);
      assert.equal(
        (yield* recoveredService.resolve({ sourceId: admitted.sourceId })).source?.chunkCount,
        survivingChunks,
      );
      const calls = state.calls.length;
      const vectors = [...sdk.rows.keys()];
      yield* Scope.close(recoveredScope, Exit.void);
      const restarted = yield* open();
      assert.equal((yield* restarted.waitTerminal({ runId })).status, "completed");
      assert.equal(state.calls.length, calls);
      assert.deepEqual([...sdk.rows.keys()], vectors);
    }).pipe(Effect.provide(state.dependencies), Effect.scoped);
  },
);

it.effect(
  "waits for an in-flight vector write before persisted cancellation cleanup and removes all of that run's writes",
  () => {
    const state = setup();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "knowledge-cancel-write-" });
      yield* write(root, "README.md", Deterministic.fixtureTexts[0]);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const writeVectors = sdk.upsert.getMockImplementation()!;
      sdk.upsert.mockImplementationOnce(async (...input) => {
        entered.resolve();
        await release.promise;
        await writeVectors(...input);
      });
      const service = yield* open();
      const admitted = (yield* service.admit({ target: { root } })).run;
      yield* Effect.promise(() => entered.promise);
      const cancelling = yield* service
        .cancel({ runId: admitted.runId })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.sync(() => release.resolve());
      assert.isTrue((yield* Fiber.join(cancelling)).applied);
      assert.equal((yield* service.waitTerminal({ runId: admitted.runId })).status, "cancelled");
      assert.equal(sdk.rows.size, 0);
      assert.isNull((yield* service.list({})).embeddingIdentity);
      const repository = yield* Repository.KnowledgeRepository;
      assert.deepEqual(yield* repository.files(admitted.sourceId), []);
    }).pipe(Effect.provide(state.dependencies), Effect.scoped);
  },
);

it.effect(
  "persists failed final removal without unlocking and completes its same-ID cleanup after restart",
  () => {
    const state = setup();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "knowledge-cleanup-" });
      yield* write(root, "README.md", Deterministic.fixtureTexts[0]);
      const scope = yield* Scope.fork(yield* Effect.scope);
      const service = Context.get(
        yield* Layer.buildWithScope(Live.layer, scope),
        RepositoryKnowledge,
      );
      const first = (yield* service.admit({ target: { root } })).run;
      yield* service.waitTerminal({ runId: first.runId });
      sdk.failDelete = true;
      const removal = (yield* service.remove({ sourceId: first.sourceId })).run;
      yield* observeRun(
        service,
        removal.runId,
        (run) => run.status === "cleanup" && run.error?.code === "cleanup_failed",
      );
      assert.isNotNull((yield* service.list({})).embeddingIdentity);
      assert.equal(
        (yield* service.resolve({ sourceId: first.sourceId })).source?.indexedAt === null,
        false,
      );
      yield* Scope.close(scope, Exit.void);
      sdk.failDelete = false;
      const restarted = yield* open();
      const terminal = yield* restarted.waitTerminal({ runId: removal.runId });
      assert.equal(terminal.status, "completed");
      assert.equal(terminal.runId, removal.runId);
      assert.isNull((yield* restarted.list({})).embeddingIdentity);
      const settings = yield* Settings.ServerSettingsService;
      yield* settings.updateSettings({ knowledge: { embedding: secondSelection } });
      const next = (yield* restarted.admit({ target: { sourceId: first.sourceId } })).run;
      assert.equal((yield* restarted.waitTerminal({ runId: next.runId })).status, "completed");
      assert.equal((yield* restarted.list({})).embeddingIdentity?.dimensions, 12);
    }).pipe(Effect.provide(state.dependencies), Effect.scoped);
  },
);

it.effect(
  "rechecks identity after asynchronous query embedding and leaves LM discovery independent of unresolved OpenAI secrets",
  () => {
    const state = setup();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "knowledge-query-" });
      yield* write(root, "README.md", Deterministic.fixtureTexts[0]);
      const service = yield* open();
      const first = (yield* service.admit({ target: { root } })).run;
      yield* service.waitTerminal({ runId: first.runId });
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      state.beforeEmbed((texts) =>
        texts[0] === "query sentinel"
          ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
          : Effect.void,
      );
      const query = yield* service
        .retrieve({ sourceIds: [first.sourceId], query: "query sentinel", limit: 3 })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(started);
      const removal = (yield* service.remove({ sourceId: first.sourceId })).run;
      yield* service.waitTerminal({ runId: removal.runId });
      const settings = yield* Settings.ServerSettingsService;
      yield* settings.updateSettings({ knowledge: { embedding: secondSelection } });
      const replacement = (yield* service.admit({ target: { sourceId: first.sourceId } })).run;
      assert.equal((yield* service.waitTerminal({ runId: replacement.runId })).status, "completed");
      yield* Deferred.succeed(release, undefined);
      const stale = yield* Fiber.join(query);
      assert.equal(stale._tag, "Failure");
      if (stale._tag === "Failure")
        assert.equal(stale.failure._tag, "KnowledgeEmbeddingMismatchError");
      assert.equal(sdk.query.mock.calls.length, 0);
      yield* settings.updateSettings({
        knowledge: {
          openaiApiKey: { provider: SecretProviderId.make("test-vault"), reference: "missing" },
        },
      });
      const discovered = yield* service.embeddingModels({});
      assert.equal(discovered.models.length, Deterministic.fixtureModels.length);
      assert.equal(discovered.failures[0]?.provider, "openai");
      assert.equal(state.secretReads.length, 1);
      const retry = (yield* service.admit({ target: { sourceId: first.sourceId } })).run;
      yield* service.waitTerminal({ runId: retry.runId });
      assert.equal(state.secretReads.length, 1);
    }).pipe(Effect.provide(state.dependencies), Effect.scoped);
  },
);
