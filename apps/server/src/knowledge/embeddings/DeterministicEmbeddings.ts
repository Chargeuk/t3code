import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Knowledge from "../../../../../packages/contracts/src/knowledge.ts";
import type { KnowledgeEmbeddingModel } from "../types.ts";
import * as EmbeddingModels from "./EmbeddingModels.ts";

export const fixtureModels = [
  {
    provider: "lmstudio",
    model: "t3-knowledge-fixture-v1",
    displayName: "Deterministic fixture (8 dimensions)",
    dimensions: 8,
  },
  {
    provider: "lmstudio",
    model: "t3-knowledge-fixture-v2",
    displayName: "Deterministic fixture (12 dimensions)",
    dimensions: 12,
  },
] as const;

export const fixtureTexts = [
  "export function knowledgeAlpha() { return 'alpha sentinel'; }",
  "export function knowledgeBeta() { return 'beta sentinel'; }",
  "export function knowledgeGamma() { return 'gamma sentinel'; }",
] as const;

// Hashed token counts support repeatable identity/retrieval checks, not semantic-quality claims.
export function fixtureVector(
  text: string,
  dimensions: number = fixtureModels[0].dimensions,
): Array<number> {
  const vector = Array.from({ length: dimensions }, () => 0);
  for (const token of text.toLowerCase().match(/\S+/gu) ?? []) {
    let hash = 2166136261;
    for (const character of token) {
      hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619);
    }
    const index = (hash >>> 0) % dimensions;
    vector[index] = (vector[index] ?? 0) + 1;
  }
  const norm = Math.hypot(...vector);
  return norm === 0 ? vector : vector.map((value) => value / norm);
}

const discover = Effect.fn("DeterministicEmbeddings.discover")(() =>
  Effect.succeed({
    models: fixtureModels.map(({ provider, model, displayName }) => ({
      provider,
      model,
      displayName,
    })),
    failures: [],
  }),
);

const resolve = Effect.fn("DeterministicEmbeddings.resolve")(function* (
  selection: Knowledge.KnowledgeEmbeddingSelection,
): Effect.fn.Return<KnowledgeEmbeddingModel, Knowledge.KnowledgeOperationError> {
  const fixture = fixtureModels.find(
    ({ provider, model }) => provider === selection.provider && model === selection.model,
  );
  if (!fixture) {
    return yield* new Knowledge.KnowledgeOperationError({
      code: "embedding_unavailable",
      cause: new Error("Select a deterministic fixture model."),
    });
  }
  return {
    selection,
    effectiveBatchSize: 32,
    // One Unicode code point is one synthetic token; this exercises real chunking without a tokenizer SDK.
    countTokens: Effect.fn("DeterministicEmbeddings.countTokens")((text: string) =>
      Effect.succeed(Array.from(text).length),
    ),
    getContextLength: Effect.fn("DeterministicEmbeddings.getContextLength")(() =>
      Effect.succeed(512),
    ),
    embedBatch: Effect.fn("DeterministicEmbeddings.embedBatch")(function* (
      texts: ReadonlyArray<string>,
    ) {
      if (texts.some((text) => !text.trim())) {
        return yield* new Knowledge.KnowledgeOperationError({
          code: "embedding_request_failed",
          cause: new Error("Embedding fixture inputs must not be blank."),
        });
      }
      return texts.map((text) => fixtureVector(text, fixture.dimensions));
    }),
  };
});

export const layer = Layer.succeed(
  EmbeddingModels.EmbeddingModels,
  EmbeddingModels.EmbeddingModels.of({ discover, resolve }),
);
