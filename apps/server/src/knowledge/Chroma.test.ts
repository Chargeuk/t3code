import { assert, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import { ChromaNotFoundError } from "chromadb";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { vi } from "vite-plus/test";

import * as Knowledge from "../../../../packages/contracts/src/knowledge.ts";
import * as Chroma from "./Chroma.ts";

const sdk = vi.hoisted(() => {
  const collection = {
    get: vi.fn(),
    upsert: vi.fn(),
    query: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(),
  };
  const client = {
    getCollection: vi.fn(),
    getOrCreateCollection: vi.fn(),
    deleteCollection: vi.fn(),
  };
  return { collection, client };
});
vi.mock("chromadb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("chromadb")>();
  return {
    ...actual,
    ChromaClient: class {
      getCollection = sdk.client.getCollection;
      getOrCreateCollection = sdk.client.getOrCreateCollection;
      deleteCollection = sdk.client.deleteCollection;
    },
  };
});

function setup() {
  for (const mock of [...Object.values(sdk.collection), ...Object.values(sdk.client)])
    mock.mockReset();
  sdk.client.getCollection.mockResolvedValue(sdk.collection);
  sdk.client.getOrCreateCollection.mockResolvedValue(sdk.collection);
  sdk.client.deleteCollection.mockResolvedValue(undefined);
  sdk.collection.delete.mockResolvedValue(undefined);
  sdk.collection.upsert.mockResolvedValue(undefined);
  sdk.collection.count.mockResolvedValue(0);
  return Chroma.layer({ url: "http://chroma:8000", environmentId: EnvironmentId.make("test-env") });
}

const sourceId = Knowledge.KnowledgeSourceId.make("source-a");
const sourceB = Knowledge.KnowledgeSourceId.make("source-b");
const runId = Knowledge.KnowledgeRunId.make("run-a");
const chunk: Knowledge.KnowledgeChunkDocument = {
  sourceId,
  runId,
  relPath: "index.ts",
  fileHash: "file-hash",
  chunkId: "chunk-a",
  chunkHash: "chunk-hash",
  chunkIndex: 0,
  tokenCount: 3,
  text: "const answer = 42;",
};
const { text: _text, ...metadata } = chunk;

it.effect(
  "never queries or reads without source scope and preserves scoped result associations",
  () => {
    const layer = setup();
    sdk.collection.get.mockResolvedValue({
      ids: [chunk.chunkId],
      documents: [chunk.text],
      metadatas: [metadata],
    });
    sdk.collection.query.mockResolvedValue({
      ids: [[chunk.chunkId]],
      documents: [[chunk.text]],
      metadatas: [[metadata]],
      distances: [[0.25]],
    });
    return Effect.gen(function* () {
      const chroma = yield* Chroma.Chroma;
      assert.deepEqual(yield* chroma.get({ sourceIds: [] }), []);
      assert.deepEqual(yield* chroma.query({ sourceIds: [], vector: [1, 2], limit: 3 }), {
        matches: [],
      });
      assert.equal(sdk.client.getCollection.mock.calls.length, 0);
      assert.deepEqual(
        yield* chroma.get({ sourceIds: [sourceId], relPath: chunk.relPath, runId }),
        [chunk],
      );
      assert.deepEqual(sdk.collection.get.mock.calls[0]?.[0].where, {
        $and: [{ sourceId: { $in: [sourceId] } }, { relPath: chunk.relPath }, { runId }],
      });
      assert.deepEqual(
        yield* chroma.query({ sourceIds: [sourceId, sourceB], vector: [1, 2], limit: 3 }),
        { matches: [{ chunk, distance: 0.25 }] },
      );
      const request = sdk.collection.query.mock.calls[0]?.[0];
      assert.deepEqual(request.where, { sourceId: { $in: [sourceId, sourceB] } });
      assert.deepEqual(request.queryEmbeddings, [[1, 2]]);
      assert.equal(request.nResults, 3);
      sdk.collection.query.mockResolvedValue({
        ids: [[chunk.chunkId]],
        documents: [[chunk.text]],
        metadatas: [[metadata]],
        distances: [[null]],
      });
      const malformed = yield* Effect.result(
        chroma.query({ sourceIds: [sourceId], vector: [1, 2], limit: 3 }),
      );
      assert.isTrue(Result.isFailure(malformed));
      if (Result.isFailure(malformed)) assert.equal(malformed.failure.operation, "query");
      sdk.collection.get.mockResolvedValueOnce({ ids: [chunk.chunkId, "chunk-b"] });
      assert.equal(yield* chroma.count(sourceId), 2);
      assert.deepEqual(sdk.collection.get.mock.lastCall?.[0], {
        where: { sourceId: { $in: [sourceId] } },
        include: [],
      });
      sdk.collection.get.mockResolvedValueOnce({ ids: [] });
      assert.equal(yield* chroma.count(sourceB), 0);
      assert.deepEqual(sdk.collection.get.mock.lastCall?.[0].where, {
        sourceId: { $in: [sourceB] },
      });
      sdk.collection.get.mockRejectedValueOnce(new Error("count response lost"));
      const uncertain = yield* Effect.result(chroma.count(sourceId));
      assert.isTrue(Result.isFailure(uncertain));
      if (Result.isFailure(uncertain)) assert.equal(uncertain.failure.operation, "count");
      sdk.client.getCollection.mockRejectedValueOnce(new ChromaNotFoundError("collection absent"));
      assert.equal(yield* chroma.count(sourceId), 0);
      sdk.client.getCollection.mockRejectedValueOnce(new Error("service unavailable"));
      const unavailable = yield* Effect.result(chroma.count(sourceId));
      assert.isTrue(Result.isFailure(unavailable));
      if (Result.isFailure(unavailable)) assert.equal(unavailable.failure.operation, "count");
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "writes explicit vectors with source, file, run and chunk association and rejects invalid batches before mutation",
  () => {
    const layer = setup();
    return Effect.gen(function* () {
      const chroma = yield* Chroma.Chroma;
      const second = { ...chunk, chunkId: "chunk-b", chunkIndex: 1, text: "second" };
      yield* chroma.upsert([
        { chunk: second, vector: [3, 4] },
        { chunk, vector: [1, 2] },
      ]);
      assert.equal(sdk.client.getOrCreateCollection.mock.calls[0]?.[0].embeddingFunction, null);
      const request = sdk.collection.upsert.mock.calls[0]?.[0];
      assert.deepEqual(request.ids, [second.chunkId, chunk.chunkId]);
      assert.deepEqual(request.embeddings, [
        [3, 4],
        [1, 2],
      ]);
      assert.deepEqual(request.documents, [second.text, chunk.text]);
      assert.deepEqual(request.metadatas[1], metadata);
      assert.equal(request.metadatas[0].sourceId, sourceId);
      assert.equal(request.metadatas[0].runId, runId);
      assert.equal(request.metadatas[0].chunkIndex, 1);
      for (const vector of [[], [Number.NaN, 2], [Number.POSITIVE_INFINITY, 2], [1]]) {
        const invalid = yield* Effect.result(
          chroma.upsert([
            { chunk, vector: [1, 2] },
            { chunk: second, vector },
          ]),
        );
        assert.isTrue(Result.isFailure(invalid));
      }
      assert.equal(sdk.collection.upsert.mock.calls.length, 1);
      sdk.collection.upsert.mockRejectedValue(new Error("connection closed during write"));
      const uncertain = yield* Effect.result(chroma.upsert([{ chunk, vector: [1, 2] }]));
      assert.isTrue(Result.isFailure(uncertain));
      if (Result.isFailure(uncertain)) assert.equal(uncertain.failure.operation, "upsert");
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "keeps cleanup source-scoped and confirms final deletion separately from uncertain failures",
  () => {
    const layer = setup();
    return Effect.gen(function* () {
      const chroma = yield* Chroma.Chroma;
      yield* chroma.delete({ sourceId, relPath: chunk.relPath, runId });
      assert.deepEqual(sdk.collection.delete.mock.calls[0]?.[0].where, {
        $and: [{ sourceId: { $in: [sourceId] } }, { relPath: chunk.relPath }, { runId }],
      });
      sdk.collection.count.mockResolvedValue(1);
      assert.equal(yield* chroma.removeSource(sourceId), "retained");
      assert.equal(sdk.client.deleteCollection.mock.calls.length, 0);
      assert.deepEqual(sdk.collection.delete.mock.calls[1]?.[0].where, {
        sourceId: { $in: [sourceId] },
      });
      sdk.collection.count.mockResolvedValue(0);
      sdk.client.deleteCollection.mockRejectedValue(new Error("delete response lost"));
      const uncertain = yield* Effect.result(chroma.removeSource(sourceId));
      assert.isTrue(Result.isFailure(uncertain));
      if (Result.isFailure(uncertain)) assert.equal(uncertain.failure.operation, "removeSource");
      sdk.client.deleteCollection.mockResolvedValue(undefined);
      assert.equal(yield* chroma.removeSource(sourceId), "deleted");
      sdk.client.deleteCollection.mockRejectedValue(new ChromaNotFoundError("collection absent"));
      assert.equal(yield* chroma.removeSource(sourceId), "deleted");
      sdk.client.getCollection.mockRejectedValue(new ChromaNotFoundError("collection absent"));
      assert.equal(yield* chroma.removeSource(sourceId), "absent");
      sdk.client.getCollection.mockRejectedValue(new Error("service unavailable"));
      assert.isTrue(Result.isFailure(yield* Effect.result(chroma.removeSource(sourceId))));
      sdk.client.getCollection.mockResolvedValue(sdk.collection);
      sdk.collection.count.mockResolvedValue(1);
      assert.equal(yield* chroma.cleanupRun({ sourceId, runId }), "retained");
      assert.deepEqual(sdk.collection.delete.mock.lastCall?.[0].where, {
        $and: [{ sourceId: { $in: [sourceId] } }, { runId }],
      });
    }).pipe(Effect.provide(layer));
  },
);

it.effect("keeps removal and restart reads within each environment's vector space", () => {
  setup();
  type Row = { id: string; document: string; metadata: Record<string, string | number> };
  const collections = new Map<string, Map<string, Row>>();
  const collection = (rows: Map<string, Row>) => ({
    upsert: async (input: { ids: string[]; documents: string[]; metadatas: Row["metadata"][] }) => {
      for (const [index, id] of input.ids.entries())
        rows.set(id, { id, document: input.documents[index]!, metadata: input.metadatas[index]! });
    },
    get: async ({ where }: { where: { sourceId: { $in: string[] } } }) => {
      const selected = [...rows.values()].filter((row) =>
        where.sourceId.$in.includes(String(row.metadata.sourceId)),
      );
      return {
        ids: selected.map((row) => row.id),
        documents: selected.map((row) => row.document),
        metadatas: selected.map((row) => row.metadata),
      };
    },
    delete: async ({ where }: { where: { sourceId: { $in: string[] } } }) => {
      for (const row of rows.values())
        if (where.sourceId.$in.includes(String(row.metadata.sourceId))) rows.delete(row.id);
    },
    count: async () => rows.size,
  });
  sdk.client.getCollection.mockImplementation(async ({ name }: { name: string }) => {
    const rows = collections.get(name);
    if (!rows) throw new ChromaNotFoundError("absent");
    return collection(rows);
  });
  sdk.client.getOrCreateCollection.mockImplementation(async ({ name }: { name: string }) => {
    const rows = collections.get(name) ?? new Map<string, Row>();
    collections.set(name, rows);
    return collection(rows);
  });
  sdk.client.deleteCollection.mockImplementation(async ({ name }: { name: string }) => {
    collections.delete(name);
  });
  const configA = {
    url: "http://chroma:8000",
    environmentId: EnvironmentId.make("11111111-1111-4111-8111-111111111111"),
  };
  const configB = {
    ...configA,
    environmentId: EnvironmentId.make("22222222-2222-4222-8222-222222222222"),
  };
  return Effect.gen(function* () {
    const a = yield* Chroma.Chroma.pipe(Effect.provide(Chroma.layer(configA)));
    const b = yield* Chroma.Chroma.pipe(Effect.provide(Chroma.layer(configB)));
    const second = { ...chunk, sourceId: sourceB, chunkId: "chunk-b" };
    yield* a.upsert([{ chunk, vector: [1, 2] }]);
    yield* b.upsert([{ chunk: second, vector: [3, 4] }]);
    const restartedA = yield* Chroma.Chroma.pipe(Effect.provide(Chroma.layer(configA)));
    assert.deepEqual(yield* restartedA.get({ sourceIds: [sourceId] }), [chunk]);
    assert.equal(yield* restartedA.removeSource(sourceId), "deleted");
    assert.equal(yield* restartedA.count(sourceId), 0);
    assert.deepEqual(yield* b.get({ sourceIds: [sourceB] }), [second]);
    yield* restartedA.upsert([{ chunk, vector: [1, 2, 3] }]);
    assert.equal(yield* restartedA.count(sourceId), 1);
    assert.equal(yield* b.count(sourceB), 1);
  }).pipe(Effect.scoped);
});
