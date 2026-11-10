import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { expect, vi } from "vite-plus/test";

import * as Knowledge from "../../../../../packages/contracts/src/knowledge.ts";
import * as DeterministicEmbeddings from "./DeterministicEmbeddings.ts";
import * as EmbeddingModels from "./EmbeddingModels.ts";

type Sdk = typeof EmbeddingModels.EmbeddingSdk.Service;
type OpenAiResponse = { data: Array<{ index: number; embedding: ReadonlyArray<number> }> };

const config = { lmStudioBaseUrl: "http://lmstudio.test:1234", openaiApiKey: "test-key" };
const openAiSelection = { provider: "openai", model: "text-embedding-3-small" } as const;
const lmStudioSelection = { provider: "lmstudio", model: "downloaded-embedding" } as const;
const texts = DeterministicEmbeddings.fixtureTexts;
const vector = DeterministicEmbeddings.fixtureVector;

// These stubs replace SDK/transport boundaries; every adapter operation still uses the real layer.
function sdkStubs(overrides: Partial<Sdk> = {}): Sdk {
  return {
    lmstudio: async () => ({
      system: {
        listDownloadedModels: async () => [
          {
            type: "embedding",
            modelKey: lmStudioSelection.model,
            displayName: "Downloaded embedding",
          },
        ],
      },
      embedding: {
        model: async () => ({
          embed: async (text) => ({ embedding: vector(text) }),
          countTokens: async (text) => Array.from(text).length,
          getContextLength: async () => 512,
        }),
      },
    }),
    openai: async () => ({
      models: {
        list: async () => ({
          data: [
            { id: "text-embedding-ada-002" },
            { id: "text-embedding-3-large" },
            { id: "text-embedding-3-small" },
            { id: "chat-model" },
          ],
        }),
      },
      embeddings: {
        create: async ({ input }) => ({
          data: input.map((text, index) => ({ index, embedding: vector(text) })).reverse(),
        }),
      },
    }),
    tokenizer: async () => ({ encode: (text) => Array.from(text), free: () => {} }),
    ...overrides,
  };
}

function sdkLayer(sdk: Sdk) {
  return EmbeddingModels.layer.pipe(
    Layer.provide(Layer.succeed(EmbeddingModels.EmbeddingSdk, sdk)),
  );
}

it.effect(
  "filters downloaded embedding models by capability and usable key without requiring OpenAI",
  () => {
    const sdk = sdkStubs({
      lmstudio: async () => ({
        system: {
          listDownloadedModels: async () => [
            { type: "llm", modelKey: "chat-only" },
            { type: "EMBEDDING", modelKey: "native-key", displayName: "Native" },
            { capabilities: ["embedding"], modelKey: "capability-key" },
            { type: "embedding", displayName: "No usable key" },
            { type: "embedding", modelKey: "  " },
            { type: "embedding", modelKey: "native-key", displayName: "Native" },
          ],
        },
        embedding: {
          model: async () => {
            throw new Error("Discovery must not load a model.");
          },
        },
      }),
      openai: async () => {
        throw new Error("Unconfigured OpenAI must not be contacted.");
      },
    });
    return Effect.gen(function* () {
      const service = yield* EmbeddingModels.EmbeddingModels;
      expect(
        yield* service.discover({ lmStudioBaseUrl: config.lmStudioBaseUrl, openaiApiKey: "  " }),
      ).toEqual({
        models: [
          { provider: "lmstudio", model: "native-key", displayName: "Native" },
          { provider: "lmstudio", model: "capability-key", displayName: "capability-key" },
        ],
        failures: [],
      });
      const failure = yield* service
        .resolve(openAiSelection, { lmStudioBaseUrl: config.lmStudioBaseUrl })
        .pipe(Effect.flip);
      expect(failure.code).toBe("embedding_unavailable");
    }).pipe(Effect.provide(sdkLayer(sdk)));
  },
);

it.effect("intersects OpenAI discovery with the accepted model choices", () =>
  Effect.gen(function* () {
    const service = yield* EmbeddingModels.EmbeddingModels;
    const result = yield* service.discover(config);
    expect(result.models.filter(({ provider }) => provider === "openai")).toEqual([
      { ...openAiSelection, displayName: openAiSelection.model },
      {
        provider: "openai",
        model: "text-embedding-3-large",
        displayName: "text-embedding-3-large",
      },
    ]);
    expect(result.failures).toEqual([]);
  }).pipe(Effect.provide(sdkLayer(sdkStubs()))),
);

it.effect("keeps discovery failures independent and exposes safe domain errors", () =>
  Effect.gen(function* () {
    for (const failedProvider of ["lmstudio", "openai"] as const) {
      const cause = new Error("SDK payload containing private detail");
      const sdk = sdkStubs({
        [failedProvider]: async () => {
          throw cause;
        },
      });
      yield* Effect.gen(function* () {
        const service = yield* EmbeddingModels.EmbeddingModels;
        const result = yield* service.discover(config);
        expect(result.models.length).toBeGreaterThan(0);
        expect(result.models.every(({ provider }) => provider !== failedProvider)).toBe(true);
        expect(result.failures).toEqual([
          {
            provider: failedProvider,
            error: {
              code: "embedding_unavailable",
              message: new Knowledge.KnowledgeOperationError({
                code: "embedding_unavailable",
                cause,
              }).message,
              relPath: null,
            },
          },
        ]);
        expect(JSON.stringify(result)).not.toContain(cause.message);
      }).pipe(Effect.provide(sdkLayer(sdk)));
    }
  }),
);

it.effect(
  "normalizes LM Studio endpoints and uses the selected native model's token/context APIs",
  () =>
    Effect.gen(function* () {
      for (const [baseUrl, expectedUrl] of [
        ["http://lmstudio.test:1234", "ws://lmstudio.test:1234"],
        ["https://lmstudio.test/native", "wss://lmstudio.test/native"],
        ["ws://lmstudio.test:1234", "ws://lmstudio.test:1234"],
        ["wss://lmstudio.test/native", "wss://lmstudio.test/native"],
      ] as const) {
        const sdk = sdkStubs({
          lmstudio: async (endpoint) => {
            if (endpoint !== expectedUrl) throw new Error("Unexpected endpoint.");
            return {
              system: {
                listDownloadedModels: async () => [
                  { type: "embedding", modelKey: lmStudioSelection.model },
                ],
              },
              embedding: {
                model: async (key) => {
                  if (key !== lmStudioSelection.model) throw new Error("Unexpected model key.");
                  return {
                    embed: async (input) => ({ embedding: vector(input) }),
                    countTokens: async (text) => (text === texts[0] ? 17 : 23),
                    getContextLength: async () => 4096,
                  };
                },
              },
            };
          },
        });
        yield* Effect.gen(function* () {
          const service = yield* EmbeddingModels.EmbeddingModels;
          const endpointConfig = { lmStudioBaseUrl: baseUrl };
          expect((yield* service.discover(endpointConfig)).failures).toEqual([]);
          const model = yield* service.resolve(lmStudioSelection, endpointConfig);
          expect(yield* model.countTokens(texts[0])).toBe(17);
          expect(yield* model.getContextLength()).toBe(4096);
          expect(yield* model.embedBatch([texts[0]])).toEqual([vector(texts[0])]);
          for (const input of [[" "], [texts[0], texts[1]]]) {
            expect((yield* model.embedBatch(input).pipe(Effect.flip)).code).toBe(
              "embedding_request_failed",
            );
          }
        }).pipe(Effect.provide(sdkLayer(sdk)));
      }
    }),
);

it.effect(
  "maps returned OpenAI indices independently when concurrent requests complete in reverse order",
  () => {
    const firstStarted = Promise.withResolvers<void>();
    const secondStarted = Promise.withResolvers<void>();
    const firstResponse = Promise.withResolvers<OpenAiResponse>();
    const secondResponse = Promise.withResolvers<OpenAiResponse>();
    const sdk = sdkStubs({
      openai: async () => ({
        models: { list: async () => ({ data: [] }) },
        embeddings: {
          create: ({ input }) => {
            if (input[0] === texts[0]) {
              firstStarted.resolve();
              return firstResponse.promise;
            }
            secondStarted.resolve();
            return secondResponse.promise;
          },
        },
      }),
    });
    return Effect.gen(function* () {
      const service = yield* EmbeddingModels.EmbeddingModels;
      const model = yield* service.resolve(openAiSelection, config);
      let firstCompleted = false;
      const first = yield* model.embedBatch([texts[0], texts[1]]).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            firstCompleted = true;
          }),
        ),
        Effect.forkChild,
      );
      yield* Effect.promise(() => firstStarted.promise);
      const second = yield* model.embedBatch([texts[2]]).pipe(Effect.forkChild);
      yield* Effect.promise(() => secondStarted.promise);
      secondResponse.resolve({ data: [{ index: 0, embedding: vector(texts[2]) }] });
      expect(yield* Fiber.join(second)).toEqual([vector(texts[2])]);
      expect(firstCompleted).toBe(false);
      firstResponse.resolve({
        data: [
          { index: 1, embedding: vector(texts[1]) },
          { index: 0, embedding: vector(texts[0]) },
        ],
      });
      expect(yield* Fiber.join(first)).toEqual([vector(texts[0]), vector(texts[1])]);
    }).pipe(Effect.provide(sdkLayer(sdk)));
  },
);

it.effect("rejects missing, duplicate, out-of-range and noninteger response indices", () =>
  Effect.gen(function* () {
    for (const indices of [[], [0], [0, 0], [1, 1], [0, 2], [-1, 0], [0, 0.5], [0, NaN]]) {
      const sdk = sdkStubs({
        openai: async () => ({
          models: { list: async () => ({ data: [] }) },
          embeddings: {
            create: async () => ({
              data: indices.map((index) => ({ index, embedding: vector(texts[0]) })),
            }),
          },
        }),
      });
      yield* Effect.gen(function* () {
        const service = yield* EmbeddingModels.EmbeddingModels;
        const model = yield* service.resolve(openAiSelection, config);
        expect((yield* model.embedBatch([texts[0], texts[1]]).pipe(Effect.flip)).code).toBe(
          "embedding_request_failed",
        );
      }).pipe(Effect.provide(sdkLayer(sdk)));
    }
  }),
);

it.effect("rejects malformed vectors from either SDK and inconsistent OpenAI dimensions", () =>
  Effect.gen(function* () {
    for (const embedding of [
      [],
      [NaN],
      [Infinity],
      [-Infinity],
      Array<number>(3),
      ["invalid"] as unknown as Array<number>,
      null as unknown as Array<number>,
    ]) {
      const sdk = sdkStubs({
        lmstudio: async () => ({
          system: { listDownloadedModels: async () => [] },
          embedding: {
            model: async () => ({
              embed: async () => ({ embedding }),
              countTokens: async () => 1,
              getContextLength: async () => 512,
            }),
          },
        }),
        openai: async () => ({
          models: { list: async () => ({ data: [] }) },
          embeddings: { create: async () => ({ data: [{ index: 0, embedding }] }) },
        }),
      });
      yield* Effect.gen(function* () {
        const service = yield* EmbeddingModels.EmbeddingModels;
        for (const selection of [openAiSelection, lmStudioSelection]) {
          const model = yield* service.resolve(selection, config);
          expect((yield* model.embedBatch([texts[0]]).pipe(Effect.flip)).code).toBe(
            "embedding_request_failed",
          );
        }
      }).pipe(Effect.provide(sdkLayer(sdk)));
    }
    yield* Effect.gen(function* () {
      const service = yield* EmbeddingModels.EmbeddingModels;
      const model = yield* service.resolve(openAiSelection, config);
      expect((yield* model.embedBatch([texts[0], texts[1]]).pipe(Effect.flip)).code).toBe(
        "embedding_dimensions_mismatch",
      );
    }).pipe(
      Effect.provide(
        sdkLayer(
          sdkStubs({
            openai: async () => ({
              models: { list: async () => ({ data: [] }) },
              embeddings: {
                create: async () => ({
                  data: [
                    { index: 0, embedding: [1, 2] },
                    { index: 1, embedding: [1, 2, 3] },
                  ],
                }),
              },
            }),
          }),
        ),
      ),
    );
  }),
);

it.effect("counts special-token spellings as ordinary text with the default tokenizer", () =>
  Effect.gen(function* () {
    const defaults = yield* EmbeddingModels.EmbeddingSdk;
    const inputs = [
      'export const marker = "<|endoftext|>";',
      "Find uses of <|fim_prefix|> in this repository",
    ];
    yield* Effect.gen(function* () {
      const service = yield* EmbeddingModels.EmbeddingModels;
      const model = yield* service.resolve(openAiSelection, config);
      for (const input of inputs) {
        expect(yield* model.countTokens(input)).toBeGreaterThan(1);
      }
      expect(yield* model.embedBatch(inputs)).toEqual(inputs.map((input) => vector(input)));
    }).pipe(Effect.provide(sdkLayer(sdkStubs({ tokenizer: defaults.tokenizer }))));
  }),
);

it.effect("enforces OpenAI input/token limits before contacting the transport", () => {
  const create = vi.fn(async () => {
    throw new Error("Invalid inputs must not reach the transport.");
  });
  const sdk = sdkStubs({
    openai: async () => ({
      models: { list: async () => ({ data: [] }) },
      embeddings: { create },
    }),
  });
  return Effect.gen(function* () {
    const service = yield* EmbeddingModels.EmbeddingModels;
    const model = yield* service.resolve(openAiSelection, config);
    for (const inputs of [
      [],
      [""],
      ["\n "],
      Array<string>(2049).fill("a"),
      ["a".repeat(8193)],
      Array<string>(38).fill("a".repeat(8192)),
    ]) {
      expect((yield* model.embedBatch(inputs).pipe(Effect.flip)).code).toBe(
        "embedding_request_failed",
      );
    }
    expect(create).not.toHaveBeenCalled();
  }).pipe(Effect.provide(sdkLayer(sdk)));
});

it.effect(
  "captures endpoint/key configuration and shares a lazily acquired tokenizer until layer release",
  () => {
    const free = vi.fn();
    const tokenizer = vi.fn(async () => ({ encode: (text: string) => Array.from(text), free }));
    const sdk = sdkStubs({
      tokenizer,
      openai: async ({ apiKey, baseUrl }) => {
        if (apiKey !== "test-key" || baseUrl !== "https://openai.test/v1")
          throw new Error("Unexpected configuration.");
        return await sdkStubs().openai({ apiKey });
      },
    });
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const service = yield* EmbeddingModels.EmbeddingModels;
        const model = yield* service.resolve(openAiSelection, {
          ...config,
          openaiApiKey: " test-key ",
          openaiBaseUrl: "https://openai.test/v1",
        });
        expect(tokenizer).not.toHaveBeenCalled();
        expect(
          yield* Effect.all([model.countTokens("a😀"), model.countTokens("abc")], {
            concurrency: "unbounded",
          }),
        ).toEqual([2, 3]);
        expect(yield* model.getContextLength()).toBe(8192);
        expect(tokenizer).toHaveBeenCalledTimes(1);
        expect(free).not.toHaveBeenCalled();
      }).pipe(Effect.provide(sdkLayer(sdk)));
      expect(free).toHaveBeenCalledTimes(1);
    });
  },
);

it.effect(
  "maps SDK and tokenizer errors to the owning operation without exposing raw failure messages",
  () =>
    Effect.gen(function* () {
      const cause = new Error("private SDK payload");
      const sdk = sdkStubs({
        lmstudio: async () => ({
          system: { listDownloadedModels: async () => [] },
          embedding: {
            model: async () => ({
              embed: async () => {
                throw cause;
              },
              countTokens: async () => {
                throw cause;
              },
              getContextLength: async () => {
                throw cause;
              },
            }),
          },
        }),
        openai: async () => ({
          models: { list: async () => ({ data: [] }) },
          embeddings: {
            create: async () => {
              throw cause;
            },
          },
        }),
      });
      yield* Effect.gen(function* () {
        const service = yield* EmbeddingModels.EmbeddingModels;
        for (const selection of [lmStudioSelection, openAiSelection]) {
          const model = yield* service.resolve(selection, config);
          const error = yield* model.embedBatch([texts[0]]).pipe(Effect.flip);
          expect(error.code).toBe("embedding_request_failed");
          expect(error.cause).toBe(cause);
          expect(error.message).not.toContain(cause.message);
        }
        const native = yield* service.resolve(lmStudioSelection, config);
        expect((yield* native.countTokens(texts[0]).pipe(Effect.flip)).code).toBe(
          "chunking_failed",
        );
        expect((yield* native.getContextLength().pipe(Effect.flip)).code).toBe("chunking_failed");
      }).pipe(Effect.provide(sdkLayer(sdk)));
      yield* Effect.gen(function* () {
        const service = yield* EmbeddingModels.EmbeddingModels;
        const model = yield* service.resolve(openAiSelection, config);
        const error = yield* model.countTokens(texts[0]).pipe(Effect.flip);
        expect(error.code).toBe("chunking_failed");
        expect(error.cause).toBe(cause);
      }).pipe(
        Effect.provide(
          sdkLayer(
            sdkStubs({
              tokenizer: async () => {
                throw cause;
              },
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* EmbeddingModels.EmbeddingModels;
        const error = yield* service.resolve(lmStudioSelection, config).pipe(Effect.flip);
        expect(error.code).toBe("embedding_unavailable");
        expect(error.cause).toBe(cause);
      }).pipe(
        Effect.provide(
          sdkLayer(
            sdkStubs({
              lmstudio: async () => {
                throw cause;
              },
            }),
          ),
        ),
      );
    }),
);

it.effect(
  "interrupts locally and never delivers late SDK results, aborting only the supported OpenAI request",
  () =>
    Effect.gen(function* () {
      for (const selection of [lmStudioSelection, openAiSelection]) {
        const started = Promise.withResolvers<void>();
        const pending = Promise.withResolvers<ReadonlyArray<number>>();
        const lmResponse = pending.promise.then((embedding) => ({ embedding }));
        const openAiResponse = pending.promise.then((embedding) => ({
          data: [{ index: 0, embedding }],
        }));
        let requestSignal: AbortSignal | undefined;
        const sdk = sdkStubs({
          lmstudio: async () => ({
            system: { listDownloadedModels: async () => [] },
            embedding: {
              model: async () => ({
                embed: () => {
                  started.resolve();
                  return lmResponse;
                },
                countTokens: async () => 1,
                getContextLength: async () => 512,
              }),
            },
          }),
          openai: async () => ({
            models: { list: async () => ({ data: [] }) },
            embeddings: {
              create: (_body, { signal }) => {
                requestSignal = signal;
                started.resolve();
                return openAiResponse;
              },
            },
          }),
        });
        yield* Effect.gen(function* () {
          const service = yield* EmbeddingModels.EmbeddingModels;
          const model = yield* service.resolve(selection, config);
          const delivered: Array<ReadonlyArray<ReadonlyArray<number>>> = [];
          const fiber = yield* model.embedBatch([texts[0]]).pipe(
            Effect.tap((vectors) =>
              Effect.sync(() => {
                delivered.push(vectors);
              }),
            ),
            Effect.forkChild,
          );
          yield* Effect.promise(() => started.promise);
          yield* Fiber.interrupt(fiber);
          if (selection.provider === "openai") expect(requestSignal?.aborted).toBe(true);
          else expect(requestSignal).toBeUndefined();
          pending.resolve(vector(texts[0]));
          yield* Effect.promise(async () => {
            await lmResponse;
            await openAiResponse;
          });
          expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
          expect(delivered).toEqual([]);
        }).pipe(Effect.provide(sdkLayer(sdk)));
      }
    }),
);
