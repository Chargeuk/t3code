import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as Knowledge from "../../../../../packages/contracts/src/knowledge.ts";
import type { KnowledgeEmbeddingModel } from "../types.ts";

export interface EmbeddingModelsConfig {
  readonly lmStudioBaseUrl: string;
  readonly openaiApiKey?: string;
  readonly openaiBaseUrl?: string;
}

export type EmbeddingModelChoice = Knowledge.KnowledgeEmbeddingSelection & {
  readonly displayName: string;
};

export interface EmbeddingDiscovery {
  readonly models: ReadonlyArray<EmbeddingModelChoice>;
  readonly failures: ReadonlyArray<{
    readonly provider: Knowledge.KnowledgeEmbeddingSelection["provider"];
    readonly error: Knowledge.KnowledgeRunFailure;
  }>;
}

interface LmStudioModel {
  readonly embed: (input: string) => Promise<{ embedding: ReadonlyArray<number> }>;
  readonly countTokens: (input: string) => Promise<number>;
  readonly getContextLength: () => Promise<number>;
}

interface LmStudioClient {
  readonly system: {
    readonly listDownloadedModels: () => Promise<
      ReadonlyArray<{
        readonly type?: string;
        readonly capabilities?: ReadonlyArray<string>;
        readonly modelKey?: string;
        readonly displayName?: string;
      }>
    >;
  };
  readonly embedding: { readonly model: (key: string) => Promise<LmStudioModel> };
}

interface OpenAiClient {
  readonly models: {
    readonly list: (options: { signal: AbortSignal }) => PromiseLike<{
      data: ReadonlyArray<{ id: string }>;
    }>;
  };
  readonly embeddings: {
    readonly create: (
      body: { model: string; input: Array<string> },
      options: { signal: AbortSignal },
    ) => PromiseLike<{ data: ReadonlyArray<{ index: number; embedding: ReadonlyArray<number> }> }>;
  };
}

// Keep SDK stubs at the external boundary; the deterministic service layer is a separate seam.
export const EmbeddingSdk = Context.Reference<{
  readonly lmstudio: (baseUrl: string) => Promise<LmStudioClient>;
  readonly openai: (config: { apiKey: string; baseUrl?: string }) => Promise<OpenAiClient>;
  readonly tokenizer: () => Promise<{
    readonly encode: (text: string) => { readonly length: number };
    readonly free: () => void;
  }>;
}>("t3/knowledge/EmbeddingSdk", {
  defaultValue: () => ({
    lmstudio: async (baseUrl) => {
      const { LMStudioClient } = await import("@lmstudio/sdk");
      return new LMStudioClient({ baseUrl });
    },
    openai: async ({ apiKey, baseUrl }) => {
      const { OpenAI } = await import("openai");
      return new OpenAI({
        apiKey,
        ...(baseUrl === undefined ? {} : { baseURL: baseUrl }),
        timeout: 30_000,
        maxRetries: 0,
      });
    },
    tokenizer: async () => {
      const { get_encoding } = await import("tiktoken");
      return get_encoding("cl100k_base");
    },
  }),
});

export class EmbeddingModels extends Context.Service<
  EmbeddingModels,
  {
    readonly discover: (config: EmbeddingModelsConfig) => Effect.Effect<EmbeddingDiscovery>;
    readonly resolve: (
      selection: Knowledge.KnowledgeEmbeddingSelection,
      config: EmbeddingModelsConfig,
    ) => Effect.Effect<KnowledgeEmbeddingModel, Knowledge.KnowledgeOperationError>;
  }
>()("t3/knowledge/embeddings/EmbeddingModels") {}

const openAiModels = ["text-embedding-3-small", "text-embedding-3-large"] as const;
const isKnowledgeOperationError = Schema.is(Knowledge.KnowledgeOperationError);

function toWebSocketUrl(value: string): string {
  if (value.startsWith("http://")) return value.replace(/^http:/i, "ws:");
  if (value.startsWith("https://")) return value.replace(/^https:/i, "wss:");
  return value;
}

function embeddingError(code: Knowledge.KnowledgeFailureCode, cause: unknown) {
  return isKnowledgeOperationError(cause)
    ? cause
    : new Knowledge.KnowledgeOperationError({ code, cause });
}

function validateVectors(
  vectors: ReadonlyArray<ReadonlyArray<number>>,
  expectedCount: number,
): ReadonlyArray<ReadonlyArray<number>> {
  if (vectors.length !== expectedCount) throw new Error("Invalid embedding count.");
  let dimensions: number | undefined;
  for (const vector of vectors) {
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new Error("Invalid embedding vector.");
    }
    for (const value of vector) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error("Invalid embedding vector.");
      }
    }
    if (dimensions !== undefined && vector.length !== dimensions) {
      throw new Knowledge.KnowledgeOperationError({
        code: "embedding_dimensions_mismatch",
        cause: new Error("Inconsistent embedding dimensions."),
      });
    }
    dimensions = vector.length;
  }
  return vectors;
}

const make = Effect.gen(function* () {
  const sdk = yield* EmbeddingSdk;
  const scope = yield* Effect.scope;
  const tokenizer = yield* Effect.cached(
    Effect.acquireRelease(
      Effect.tryPromise({
        try: () => sdk.tokenizer(),
        catch: (cause) => embeddingError("chunking_failed", cause),
      }),
      (value) => Effect.sync(() => value.free()),
    ).pipe(Scope.provide(scope)),
  );

  const openAiClient = Effect.fn("EmbeddingModels.openAiClient")(function* (
    config: EmbeddingModelsConfig,
  ) {
    const apiKey = config.openaiApiKey?.trim();
    if (!apiKey) {
      return yield* new Knowledge.KnowledgeOperationError({
        code: "embedding_unavailable",
        cause: new Error("OpenAI embedding key is not configured."),
      });
    }
    return yield* Effect.tryPromise({
      try: () =>
        sdk.openai({
          apiKey,
          ...(config.openaiBaseUrl === undefined ? {} : { baseUrl: config.openaiBaseUrl }),
        }),
      catch: (cause) => embeddingError("embedding_unavailable", cause),
    });
  });

  const discoverLmStudio = Effect.fn("EmbeddingModels.discoverLmStudio")(function* (
    config: EmbeddingModelsConfig,
  ) {
    return yield* Effect.tryPromise({
      try: async () => {
        const client = await sdk.lmstudio(toWebSocketUrl(config.lmStudioBaseUrl));
        const downloaded = await client.system.listDownloadedModels();
        const choices = new Map<string, EmbeddingModelChoice>();
        for (const model of downloaded) {
          if (
            (model.type?.toLowerCase() === "embedding" ||
              model.capabilities?.includes("embedding")) &&
            model.modelKey?.trim()
          ) {
            choices.set(model.modelKey, {
              provider: "lmstudio",
              model: model.modelKey,
              displayName: model.displayName || model.modelKey,
            });
          }
        }
        return [...choices.values()];
      },
      catch: (cause) => embeddingError("embedding_unavailable", cause),
    });
  });

  const discoverOpenAi = Effect.fn("EmbeddingModels.discoverOpenAi")(function* (
    config: EmbeddingModelsConfig,
  ) {
    if (!config.openaiApiKey?.trim()) return [];
    const client = yield* openAiClient(config);
    const listed = yield* Effect.tryPromise({
      try: (signal) => client.models.list({ signal }),
      catch: (cause) => embeddingError("embedding_unavailable", cause),
    });
    const available = new Set(listed.data.map(({ id }) => id));
    return openAiModels
      .filter((model) => available.has(model))
      .map((model) => ({
        provider: "openai" as const,
        model,
        displayName: model,
      }));
  });

  const discover = Effect.fn("EmbeddingModels.discover")(function* (config: EmbeddingModelsConfig) {
    const results = yield* Effect.all(
      {
        lmstudio: discoverLmStudio(config).pipe(Effect.result),
        openai: discoverOpenAi(config).pipe(Effect.result),
      },
      { concurrency: "unbounded" },
    );
    const models: Array<EmbeddingModelChoice> = [];
    const failures: Array<EmbeddingDiscovery["failures"][number]> = [];
    for (const provider of ["lmstudio", "openai"] as const) {
      const result = results[provider];
      if (result._tag === "Success") models.push(...result.success);
      else
        failures.push({
          provider,
          error: { code: result.failure.code, message: result.failure.message, relPath: null },
        });
    }
    return { models, failures };
  });

  const resolve = Effect.fn("EmbeddingModels.resolve")(function* (
    selection: Knowledge.KnowledgeEmbeddingSelection,
    config: EmbeddingModelsConfig,
  ): Effect.fn.Return<KnowledgeEmbeddingModel, Knowledge.KnowledgeOperationError> {
    if (selection.provider === "lmstudio") {
      const model = yield* Effect.tryPromise({
        try: async () => {
          const client = await sdk.lmstudio(toWebSocketUrl(config.lmStudioBaseUrl));
          return client.embedding.model(selection.model);
        },
        catch: (cause) => embeddingError("embedding_unavailable", cause),
      });
      return {
        selection,
        effectiveBatchSize: 1,
        countTokens: Effect.fn("EmbeddingModels.lmStudioCountTokens")((text: string) =>
          Effect.tryPromise({
            try: () => model.countTokens(text),
            catch: (cause) => embeddingError("chunking_failed", cause),
          }),
        ),
        getContextLength: Effect.fn("EmbeddingModels.lmStudioContextLength")(() =>
          Effect.tryPromise({
            try: () => model.getContextLength(),
            catch: (cause) => embeddingError("chunking_failed", cause),
          }),
        ),
        embedBatch: Effect.fn("EmbeddingModels.lmStudioEmbedBatch")(
          (texts: ReadonlyArray<string>) =>
            Effect.try({
              try: () => {
                if (texts.length > 1 || texts.some((text) => !text.trim())) {
                  throw new Error("LM Studio requires one nonblank input per request.");
                }
              },
              catch: (cause) => embeddingError("embedding_request_failed", cause),
            }).pipe(
              // SDK 1.5 embed has no AbortSignal; interruption discards the locally awaited result.
              Effect.andThen(
                Effect.forEach(texts, (text) =>
                  Effect.tryPromise({
                    try: () => model.embed(text),
                    catch: (cause) => embeddingError("embedding_request_failed", cause),
                  }),
                ),
              ),
              Effect.flatMap((responses) =>
                Effect.try({
                  try: () =>
                    validateVectors(
                      responses.map((response) => response.embedding),
                      texts.length,
                    ),
                  catch: (cause) => embeddingError("embedding_request_failed", cause),
                }),
              ),
            ),
        ),
      };
    }

    const client = yield* openAiClient(config);
    const countTokens = Effect.fn("EmbeddingModels.openAiCountTokens")(function* (text: string) {
      const encoding = yield* tokenizer;
      return yield* Effect.try({
        try: () => encoding.encode(text).length,
        catch: (cause) => embeddingError("chunking_failed", cause),
      });
    });
    return {
      selection,
      effectiveBatchSize: 2048,
      countTokens,
      getContextLength: Effect.fn("EmbeddingModels.openAiContextLength")(() =>
        Effect.succeed(8192),
      ),
      embedBatch: Effect.fn("EmbeddingModels.openAiEmbedBatch")(function* (
        texts: ReadonlyArray<string>,
      ) {
        if (texts.length === 0 || texts.length > 2048 || texts.some((text) => !text.trim())) {
          return yield* new Knowledge.KnowledgeOperationError({
            code: "embedding_request_failed",
            cause: new Error("Invalid OpenAI embedding inputs."),
          });
        }
        const counts = yield* Effect.forEach(texts, countTokens);
        if (
          counts.some((count) => count > 8192) ||
          counts.reduce((sum, count) => sum + count, 0) > 300_000
        ) {
          return yield* new Knowledge.KnowledgeOperationError({
            code: "embedding_request_failed",
            cause: new Error("OpenAI embedding token limit exceeded."),
          });
        }
        const response = yield* Effect.tryPromise({
          try: (signal) =>
            client.embeddings.create({ model: selection.model, input: [...texts] }, { signal }),
          catch: (cause) => embeddingError("embedding_request_failed", cause),
        });
        return yield* Effect.try({
          try: () => {
            const indexed = new Map<number, ReadonlyArray<number>>();
            for (const row of response.data) {
              if (
                !Number.isInteger(row.index) ||
                row.index < 0 ||
                row.index >= texts.length ||
                indexed.has(row.index)
              ) {
                throw new Error("Invalid OpenAI embedding index.");
              }
              indexed.set(row.index, row.embedding);
            }
            if (indexed.size !== texts.length)
              throw new Error("Incomplete OpenAI embedding response.");
            return validateVectors(
              texts.map((_, index) => indexed.get(index)!),
              texts.length,
            );
          },
          catch: (cause) => embeddingError("embedding_request_failed", cause),
        });
      }),
    };
  });

  return EmbeddingModels.of({ discover, resolve });
});

export const layer = Layer.effect(EmbeddingModels, make);
