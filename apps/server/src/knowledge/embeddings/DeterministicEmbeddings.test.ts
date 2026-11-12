import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import * as DeterministicEmbeddings from "./DeterministicEmbeddings.ts";
import * as EmbeddingModels from "./EmbeddingModels.ts";

it.effect(
  "provides repeatable external embeddings and distinct model spaces through the normal service interface",
  () =>
    Effect.gen(function* () {
      const service = yield* EmbeddingModels.EmbeddingModels;
      const config = { lmStudioBaseUrl: "http://unused.invalid" };
      const discovered = yield* service.discover(config);
      expect(discovered.failures).toEqual([]);
      for (const fixture of DeterministicEmbeddings.fixtureModels) {
        const choice = discovered.models.find(({ model }) => model === fixture.model);
        expect(choice).toBeDefined();
        const selection = { provider: fixture.provider, model: fixture.model };
        const model = yield* service.resolve(selection, config);
        const reopened = yield* service.resolve(selection, config);
        const texts = DeterministicEmbeddings.fixtureTexts;
        const vectors = yield* model.embedBatch(texts);
        expect(yield* reopened.embedBatch([texts[2], texts[0]])).toEqual([vectors[2], vectors[0]]);
        expect(vectors[0]).not.toEqual(vectors[1]);
        expect(
          vectors.every(
            (vector) => vector.length === fixture.dimensions && vector.every(Number.isFinite),
          ),
        ).toBe(true);
        expect(yield* model.countTokens("a😀\nb")).toBe(4);
        const contextLength = yield* model.getContextLength();
        expect(yield* model.countTokens("a".repeat(contextLength))).toBe(contextLength);
        expect((yield* model.embedBatch([" "]).pipe(Effect.flip)).code).toBe(
          "embedding_request_failed",
        );
      }
      expect(
        (yield* service
          .resolve({ provider: "lmstudio", model: "not-a-fixture" }, config)
          .pipe(Effect.flip)).code,
      ).toBe("embedding_unavailable");
    }).pipe(Effect.provide(DeterministicEmbeddings.layer)),
);
