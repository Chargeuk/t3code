import { ChromaClient, ChromaNotFoundError, type Where } from "chromadb";
import * as Knowledge from "../../../../packages/contracts/src/knowledge.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const collectionName = "t3_knowledge_vectors";

export class ChromaError extends Schema.TaggedError<ChromaError>()("ChromaError", {
  operation: Schema.Literals([
    "configure",
    "get",
    "count",
    "upsert",
    "delete",
    "query",
    "removeSource",
    "cleanupRun",
  ]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "The Knowledge vector store operation failed. Check the configured Chroma service.";
  }
}

type SourceFilter = {
  readonly sourceId: Knowledge.KnowledgeSourceId;
  readonly relPath?: string;
  readonly runId?: Knowledge.KnowledgeRunId;
};

export class Chroma extends Context.Service<
  Chroma,
  {
    readonly get: (input: {
      readonly sourceIds: ReadonlyArray<Knowledge.KnowledgeSourceId>;
      readonly relPath?: string;
      readonly runId?: Knowledge.KnowledgeRunId;
    }) => Effect.Effect<ReadonlyArray<Knowledge.KnowledgeChunkDocument>, ChromaError>;
    readonly count: (sourceId: Knowledge.KnowledgeSourceId) => Effect.Effect<number, ChromaError>;
    readonly upsert: (
      records: ReadonlyArray<{
        readonly chunk: Knowledge.KnowledgeChunkDocument;
        readonly vector: ReadonlyArray<number>;
      }>,
    ) => Effect.Effect<void, ChromaError>;
    readonly delete: (input: SourceFilter) => Effect.Effect<void, ChromaError>;
    readonly query: (input: {
      readonly sourceIds: ReadonlyArray<Knowledge.KnowledgeSourceId>;
      readonly vector: ReadonlyArray<number>;
      readonly limit: number;
    }) => Effect.Effect<Knowledge.KnowledgeRetrieveResult, ChromaError>;
    // Only absent/deleted permit model unlock; retained means other sources still own vectors.
    readonly removeSource: (
      sourceId: Knowledge.KnowledgeSourceId,
    ) => Effect.Effect<"absent" | "deleted" | "retained", ChromaError>;
    readonly cleanupRun: (input: {
      readonly sourceId: Knowledge.KnowledgeSourceId;
      readonly runId: Knowledge.KnowledgeRunId;
    }) => Effect.Effect<"absent" | "deleted" | "retained", ChromaError>;
  }
>()("t3/knowledge/Chroma") {}

function scopeWhere(
  sourceIds: ReadonlyArray<Knowledge.KnowledgeSourceId>,
  relPath?: string,
  runId?: Knowledge.KnowledgeRunId,
): Where {
  const terms: Where[] = [{ sourceId: { $in: [...sourceIds] } }];
  if (relPath !== undefined) terms.push({ relPath });
  if (runId !== undefined) terms.push({ runId });
  return terms.length === 1 ? terms[0]! : { $and: terms };
}

// Per-chunk decoding shares the enclosing vector operation's span.
const decodeChunk = Effect.fnUntraced(function* (
  id: string,
  document: string | null | undefined,
  metadata: unknown,
) {
  return yield* Schema.decodeUnknownEffect(Knowledge.KnowledgeChunkDocument)({
    ...(typeof metadata === "object" && metadata !== null ? metadata : {}),
    chunkId: id,
    text: document,
  });
});

const make = Effect.fn("Chroma.make")(function* (config: { readonly url: string }) {
  const client = yield* Effect.try({
    try: () => {
      const url = new URL(config.url);
      return new ChromaClient({
        host: url.hostname,
        port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
        ssl: url.protocol === "https:",
      });
    },
    catch: (cause) => new ChromaError({ operation: "configure", cause }),
  });

  const existing = Effect.fn("Chroma.existing")(function* (operation: ChromaError["operation"]) {
    return yield* Effect.tryPromise({
      // 3.1.6 getCollection has no nullable embeddingFunction option; reads never supply text queries.
      try: () => client.getCollection({ name: collectionName }),
      catch: (cause) => new ChromaError({ operation, cause }),
    }).pipe(
      Effect.catchIf(
        (error) => error.cause instanceof ChromaNotFoundError,
        () => Effect.succeed(null),
      ),
    );
  });

  const get: Chroma["Service"]["get"] = Effect.fn("Chroma.get")(
    function* (input: Parameters<Chroma["Service"]["get"]>[0]) {
      if (input.sourceIds.length === 0) return [];
      const collection = yield* existing("get");
      if (!collection) return [];
      const result = yield* Effect.tryPromise({
        try: () =>
          collection.get({
            where: scopeWhere(input.sourceIds, input.relPath, input.runId),
            include: ["documents", "metadatas"],
          }),
        catch: (cause) => new ChromaError({ operation: "get", cause }),
      });
      return yield* Effect.forEach(result.ids, (id, i) =>
        decodeChunk(id, result.documents[i], result.metadatas[i]),
      );
    },
    Effect.mapError((cause) =>
      Schema.is(ChromaError)(cause) ? cause : new ChromaError({ operation: "get", cause }),
    ),
  );

  const count: Chroma["Service"]["count"] = Effect.fn("Chroma.count")(function* (
    sourceId: Knowledge.KnowledgeSourceId,
  ) {
    const collection = yield* existing("count");
    if (!collection) return 0;
    const result = yield* Effect.tryPromise({
      try: () => collection.get({ where: scopeWhere([sourceId]), include: [] }),
      catch: (cause) => new ChromaError({ operation: "count", cause }),
    });
    return result.ids.length;
  });

  const upsert: Chroma["Service"]["upsert"] = Effect.fn("Chroma.upsert")(function* (
    records: Parameters<Chroma["Service"]["upsert"]>[0],
  ) {
    if (records.length === 0) return;
    const dimensions = records[0]!.vector.length;
    if (
      dimensions === 0 ||
      records.some(
        (r) => r.vector.length !== dimensions || r.vector.some((value) => !Number.isFinite(value)),
      )
    ) {
      return yield* new ChromaError({
        operation: "upsert",
        cause: new Error("Invalid embedding dimensions or values"),
      });
    }
    const collection = yield* Effect.tryPromise({
      try: () =>
        client.getOrCreateCollection({
          name: collectionName,
          embeddingFunction: null,
        }),
      catch: (cause) => new ChromaError({ operation: "upsert", cause }),
    });
    yield* Effect.tryPromise({
      try: () =>
        collection.upsert({
          ids: records.map((r) => r.chunk.chunkId),
          embeddings: records.map((r) => [...r.vector]),
          documents: records.map((r) => r.chunk.text),
          metadatas: records.map(({ chunk: { text: _text, ...metadata } }) => metadata),
        }),
      catch: (cause) => new ChromaError({ operation: "upsert", cause }),
    });
  });

  const deleteChunks: Chroma["Service"]["delete"] = Effect.fn("Chroma.delete")(function* (
    input: SourceFilter,
  ) {
    const collection = yield* existing("delete");
    if (!collection) return;
    yield* Effect.tryPromise({
      try: () =>
        collection.delete({ where: scopeWhere([input.sourceId], input.relPath, input.runId) }),
      catch: (cause) => new ChromaError({ operation: "delete", cause }),
    });
  });

  const query: Chroma["Service"]["query"] = Effect.fn("Chroma.query")(
    function* (input: Parameters<Chroma["Service"]["query"]>[0]) {
      if (input.sourceIds.length === 0) return { matches: [] };
      const collection = yield* existing("query");
      if (!collection) return { matches: [] };
      const result = yield* Effect.tryPromise({
        try: () =>
          collection.query({
            where: scopeWhere(input.sourceIds),
            queryEmbeddings: [[...input.vector]],
            nResults: input.limit,
            include: ["documents", "metadatas", "distances"],
          }),
        catch: (cause) => new ChromaError({ operation: "query", cause }),
      });
      const ids = result.ids[0] ?? [];
      const matches = yield* Effect.forEach(ids, (id, i) =>
        decodeChunk(id, result.documents[0]?.[i], result.metadatas[0]?.[i]).pipe(
          Effect.map((chunk) => ({ chunk, distance: result.distances[0]?.[i] })),
        ),
      );
      return yield* Schema.decodeUnknownEffect(Knowledge.KnowledgeRetrieveResult)({ matches });
    },
    Effect.mapError((cause) =>
      Schema.is(ChromaError)(cause) ? cause : new ChromaError({ operation: "query", cause }),
    ),
  );

  const removeOwned = Effect.fn("Chroma.removeOwned")(function* (
    input: SourceFilter,
    operation: "removeSource" | "cleanupRun",
  ) {
    const collection = yield* existing(operation);
    if (!collection) return "absent" as const;
    yield* Effect.tryPromise({
      try: () =>
        collection.delete({ where: scopeWhere([input.sourceId], input.relPath, input.runId) }),
      catch: (cause) => new ChromaError({ operation, cause }),
    });
    const remaining = yield* Effect.tryPromise({
      try: () => collection.count(),
      catch: (cause) => new ChromaError({ operation, cause }),
    });
    if (remaining > 0) return "retained" as const;
    yield* Effect.tryPromise({
      try: () => client.deleteCollection({ name: collectionName }),
      catch: (cause) => new ChromaError({ operation, cause }),
    }).pipe(
      Effect.catchIf(
        (error) => error.cause instanceof ChromaNotFoundError,
        () => Effect.void,
      ),
    );
    return "deleted" as const;
  });

  const removeSource: Chroma["Service"]["removeSource"] = Effect.fn("Chroma.removeSource")(
    (sourceId: Knowledge.KnowledgeSourceId) => removeOwned({ sourceId }, "removeSource"),
  );
  const cleanupRun: Chroma["Service"]["cleanupRun"] = Effect.fn("Chroma.cleanupRun")(
    (input: Parameters<Chroma["Service"]["cleanupRun"]>[0]) => removeOwned(input, "cleanupRun"),
  );

  return Chroma.of({ get, count, upsert, delete: deleteChunks, query, removeSource, cleanupRun });
});

export const layer = (config: { readonly url: string }) => Layer.effect(Chroma, make(config));
