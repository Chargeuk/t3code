import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";

import * as Knowledge from "../../../../packages/contracts/src/knowledge.ts";
import migration from "../persistence/Migrations/081_RepositoryKnowledge.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Repository from "./KnowledgeRepository.ts";

const database = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tables = yield* sql`SELECT name FROM sqlite_schema WHERE name = 'knowledge_sources'`;
    if (tables.length === 0) yield* migration;
  }),
).pipe(Layer.provideMerge(Sqlite.layerMemory));
const layer = Repository.layer.pipe(Layer.provideMerge(database));

const now = "2026-11-10T12:00:00.000Z";
const selection: Knowledge.KnowledgeEmbeddingSelection = {
  provider: "openai",
  model: "text-embedding-3-small",
};
const otherSelection: Knowledge.KnowledgeEmbeddingSelection = {
  provider: "lmstudio",
  model: "fixture",
};
const identity: Knowledge.KnowledgeEmbeddingIdentity = { selection, dimensions: 3 };
const sourceId = Knowledge.KnowledgeSourceId.make("source-a");
const runId = Knowledge.KnowledgeRunId.make("run-a");
const sourceB = Knowledge.KnowledgeSourceId.make("source-b");
const runB = Knowledge.KnowledgeRunId.make("run-b");
const counts: Knowledge.KnowledgeRunCounts = {
  discoveredFiles: 1,
  processedFiles: 1,
  addedFiles: 1,
  changedFiles: 0,
  deletedFiles: 0,
  unchangedFiles: 0,
  chunks: 2,
  embeddedChunks: 2,
};
const file: Knowledge.KnowledgeIndexedFile = {
  sourceId,
  runId,
  relPath: "index.ts",
  fileHash: "hash-a",
};
const coverage: Knowledge.KnowledgeAstCoverage = {
  supportedFileCount: 1,
  skippedFileCount: 0,
  failedFileCount: 0,
  lastIndexedAt: now,
};
const astFile: Repository.KnowledgeAstFile = {
  ...file,
  symbols: [
    {
      ...file,
      symbolId: "symbol-a",
      language: "typescript",
      kind: "Function",
      name: "answer",
      range: { start: { line: 1, column: 1 }, end: { line: 3, column: 2 } },
    },
  ],
  edges: [],
  references: [],
  imports: { ...file, imports: [] },
};
const admission = {
  sourceId,
  runId,
  root: "/repos/a",
  operation: "ingest" as const,
  embedding: selection,
  now,
};

it.effect(
  "deduplicates canonical roots, replaces queued input in place and claims FIFO with stable active input",
  () =>
    Effect.gen(function* () {
      const repository = yield* Repository.KnowledgeRepository;
      assert.isNull(yield* repository.resolve({ root: admission.root }));
      assert.lengthOf((yield* repository.list()).sources, 0);
      const first = (yield* repository.admit(admission)).run;
      const second = (yield* repository.admit({
        ...admission,
        sourceId: sourceB,
        runId: runB,
        root: "/repos/b",
      })).run;
      const replacement = yield* repository.admit({
        ...admission,
        sourceId: sourceB,
        runId: Knowledge.KnowledgeRunId.make("discarded"),
        embedding: otherSelection,
      });
      const replaced = replacement.run;
      assert.isTrue(replacement.changed);
      assert.equal(replaced.runId, first.runId);
      assert.equal(replaced.sourceId, sourceId);
      assert.equal(replaced.admissionOrder, first.admissionOrder);
      assert.equal(replaced.queuePosition, 1);
      assert.deepEqual(replaced.embedding, otherSelection);
      assert.equal(second.queuePosition, 2);
      const active = yield* repository.claimOldest(now);
      assert.equal(active?.runId, first.runId);
      assert.deepEqual(active?.embedding, otherSelection);
      assert.isNull(yield* repository.claimOldest(now));
      const duplicateActive = yield* repository.admit(admission);
      assert.isFalse(duplicateActive.changed);
      assert.deepEqual(duplicateActive.run.embedding, otherSelection);
      assert.equal(duplicateActive.run.runId, first.runId);
      assert.equal((yield* repository.getRun(runB)).queuePosition, 1);
      const busy = yield* Effect.result(
        repository.admit({ ...admission, operation: "remove", embedding: null }),
      );
      assert.isTrue(Result.isFailure(busy));
      if (Result.isFailure(busy)) assert.equal(busy.failure._tag, "KnowledgeSourceBusyError");
      yield* repository.finish({
        runId,
        status: "failed",
        error: { code: "embedding_request_failed", message: "Embedding failed.", relPath: null },
        now,
      });
      assert.equal((yield* repository.claimOldest(now))?.runId, second.runId);
      assert.lengthOf((yield* repository.list()).sources, 2);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "recovers abandoned attempts under the same identity and preserves durable cleanup intent",
  () =>
    Effect.gen(function* () {
      const repository = yield* Repository.KnowledgeRepository;
      yield* repository.admit(admission);
      yield* repository.claimOldest(now);
      yield* repository.progress({
        runId,
        stage: "embedding",
        currentFile: file.relPath,
        counts,
        embeddingIdentity: identity,
        now,
      });
      assert.equal((yield* repository.getRun(runId)).currentFile, file.relPath);
      const recovered = yield* repository.recover(now);
      assert.equal(recovered[0]?.runId, runId);
      assert.equal(recovered[0]?.status, "queued");
      assert.equal(recovered[0]?.counts.processedFiles, 0);
      assert.isNull(recovered[0]?.currentFile);
      assert.deepEqual(recovered[0]?.embedding, selection);
      yield* repository.claimOldest(now);
      yield* repository.beginCleanup({ runId, intent: "cancel", error: null, now });
      const cleanup = (yield* repository.recover(now))[0];
      assert.equal(cleanup?.runId, runId);
      assert.equal(cleanup?.status, "cleanup");
      assert.equal(cleanup?.cleanupIntent, "cancel");
      assert.isNull(yield* repository.claimOldest(now));
      assert.isFalse(
        yield* repository.progress({
          runId,
          stage: "ast",
          currentFile: file.relPath,
          counts,
          embeddingIdentity: identity,
          now,
        }),
      );
      assert.isFalse(
        yield* repository.finalize({
          runId,
          files: [file],
          ast: { files: [astFile], coverage },
          counts,
          now,
        }),
      );
      yield* repository.finish({ runId, status: "cancelled", error: null, now });
      assert.deepEqual(yield* repository.recover(now), []);
      assert.equal((yield* repository.getRun(runId)).status, "cancelled");
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "commits hashes, live AST and success atomically, rolling back failed replacement and preserving prior AST",
  () =>
    Effect.gen(function* () {
      const repository = yield* Repository.KnowledgeRepository;
      yield* repository.admit(admission);
      yield* repository.claimOldest(now);
      assert.isTrue(
        yield* repository.finalize({
          runId,
          files: [file],
          ast: { files: [astFile], coverage },
          counts,
          now,
        }),
      );
      assert.deepEqual(yield* repository.files(sourceId), [file]);
      assert.deepEqual(yield* repository.astFiles(sourceId), [astFile]);
      assert.deepEqual(yield* repository.astFiles(sourceB), []);
      const nextId = Knowledge.KnowledgeRunId.make("run-next");
      yield* repository.admit({ ...admission, runId: nextId });
      yield* repository.claimOldest(now);
      const nextFile = { ...file, runId: nextId, fileHash: "changed" };
      const failed = yield* Effect.result(
        repository.finalize({
          runId: nextId,
          files: [nextFile],
          ast: { files: [astFile, astFile], coverage },
          counts,
          now,
        }),
      );
      assert.isTrue(Result.isFailure(failed));
      assert.deepEqual(yield* repository.files(sourceId), [file]);
      assert.deepEqual(yield* repository.astFiles(sourceId), [astFile]);
      assert.equal((yield* repository.getRun(nextId)).status, "running");
      assert.equal((yield* repository.resolve({ sourceId }))?.latestRun?.runId, nextId);
      assert.isTrue(
        yield* repository.finalize({ runId: nextId, files: [nextFile], ast: null, counts, now }),
      );
      assert.deepEqual(yield* repository.files(sourceId), [nextFile]);
      assert.deepEqual(yield* repository.astFiles(sourceId), [astFile]);
      assert.isFalse(
        yield* repository.finalize({
          runId: nextId,
          files: [],
          ast: { files: [], coverage },
          counts,
          now,
        }),
      );
      assert.equal((yield* repository.getRun(nextId)).status, "completed");
    }).pipe(Effect.provide(layer)),
);

it.effect("removes owned indexed state and completes cleanup while retaining source identity", () =>
  Effect.gen(function* () {
    const repository = yield* Repository.KnowledgeRepository;
    yield* repository.admit(admission);
    yield* repository.claimOldest(now);
    yield* repository.finalize({
      runId,
      files: [file],
      ast: { files: [astFile], coverage },
      counts,
      now,
    });
    yield* repository.claimEmbeddingIdentity(identity);
    const removalId = Knowledge.KnowledgeRunId.make("remove-a");
    yield* repository.admit({
      ...admission,
      runId: removalId,
      operation: "remove",
      embedding: null,
    });
    const removal = yield* repository.claimOldest(now);
    assert.equal(removal?.status, "cleanup");
    assert.equal(removal?.cleanupIntent, "remove");
    assert.equal((yield* repository.recover(now))[0]?.runId, removalId);
    assert.isTrue(
      yield* repository.clearIndexedContent({
        runId: removalId,
        unlockEmbeddingIdentity: true,
        now,
      }),
    );
    assert.isNull(yield* repository.getEmbeddingIdentity());
    assert.deepEqual(yield* repository.files(sourceId), []);
    assert.deepEqual(yield* repository.astFiles(sourceId), []);
    const retained = yield* repository.resolve({ root: admission.root });
    assert.equal(retained?.sourceId, sourceId);
    assert.equal(retained?.fileCount, 0);
    assert.isNull(retained?.indexedAt);
    assert.isNull(retained?.astCoverage);
    assert.equal((yield* repository.getRun(removalId)).status, "completed");
    const reingest = yield* repository.admit({
      ...admission,
      sourceId: sourceB,
      runId: Knowledge.KnowledgeRunId.make("reingest"),
    });
    assert.equal(reingest.run.sourceId, sourceId);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "keeps the global embedding identity through competing claims, dimension mismatch and index clearing until explicit unlock",
  () =>
    Effect.gen(function* () {
      const repository = yield* Repository.KnowledgeRepository;
      const outcomes = yield* Effect.all(
        [
          Effect.result(repository.claimEmbeddingIdentity(identity)),
          Effect.result(
            repository.claimEmbeddingIdentity({ selection: otherSelection, dimensions: 3 }),
          ),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(outcomes.filter(Result.isSuccess).length, 1);
      const locked = yield* repository.getEmbeddingIdentity();
      assert.isNotNull(locked);
      const mismatch = yield* Effect.result(
        repository.claimEmbeddingIdentity({ selection: locked!.selection, dimensions: 4 }),
      );
      assert.isTrue(Result.isFailure(mismatch));
      if (Result.isFailure(mismatch)) {
        assert.equal(mismatch.failure._tag, "KnowledgeOperationError");
        if (mismatch.failure._tag === "KnowledgeOperationError")
          assert.equal(mismatch.failure.code, "embedding_dimensions_mismatch");
      }
      yield* repository.admit(admission);
      yield* repository.claimOldest(now);
      yield* repository.beginCleanup({ runId, intent: "remove", error: null, now });
      yield* repository.clearIndexedContent({ runId, unlockEmbeddingIdentity: false, now });
      assert.deepEqual(yield* repository.getEmbeddingIdentity(), locked);
      yield* repository.unlockEmbeddingIdentity();
      assert.isNull(yield* repository.getEmbeddingIdentity());
      assert.deepEqual(yield* repository.claimEmbeddingIdentity(identity), identity);
    }).pipe(Effect.provide(layer)),
);
