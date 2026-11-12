import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { KnowledgeOperationError } from "../../../../packages/contracts/src/knowledge.ts";
import { chunkTextStream, hashChunk } from "./chunker.ts";
import type { KnowledgeChunkingOptions, KnowledgeEmbeddingModel } from "./types.ts";

const model = (
  context: number,
): Pick<KnowledgeEmbeddingModel, "countTokens" | "getContextLength"> => ({
  getContextLength: () => Effect.succeed(context),
  countTokens: (text) => Effect.succeed(text.length),
});

const config: KnowledgeChunkingOptions = {
  tokenSafetyMargin: 1,
  fallbackTokenLimit: 30,
  largeTextThresholdBytes: 64,
};

describe("Knowledge chunking", () => {
  it.effect(
    "splits structural boundaries, removes blank candidates and numbers surviving chunks",
    () =>
      Effect.gen(function* () {
        const text =
          "\r\n \r\nfunction alpha() {}\r\n\r\nclass Beta {}\r\nconst arrow = () => true;\r\nexport function gamma() {}";
        const stream = chunkTextStream(text, model(200));
        const chunks = yield* Stream.runCollect(stream);
        expect(chunks.map((chunk) => chunk.text)).toEqual([
          "function alpha() {}\n",
          "class Beta {}",
          "const arrow = () => true;",
          "export function gamma() {}",
        ]);
        expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual([0, 1, 2, 3]);
        expect(yield* Stream.runCollect(stream)).toEqual(chunks);
      }),
  );

  it.effect.each(["", " \n\t ", "\r\n"])("emits no chunks for blank input %j", (text) =>
    Effect.gen(function* () {
      expect(yield* Stream.runCollect(chunkTextStream(text, model(200)))).toEqual([]);
    }),
  );

  it.effect("slices oversized content within token limits and skips whitespace slices", () =>
    Effect.gen(function* () {
      for (const { text, context } of [
        { text: `${" ".repeat(45)}${"x".repeat(183)}`, context: 40 },
        { text: "x😀".repeat(80), context: 40 },
        { text: "😀".repeat(4), context: 2 },
      ]) {
        const chunks = yield* Stream.runCollect(chunkTextStream(text, model(context), { config }));
        expect(chunks.length).toBeGreaterThan(1);
        expect(
          chunks.every((chunk) => chunk.tokenCount <= context && chunk.text.trim().length > 0),
        ).toBe(true);
        expect(chunks.every((chunk) => chunk.text.isWellFormed())).toBe(true);
        expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual(chunks.map((_, index) => index));
        expect(
          chunks
            .map((chunk) => chunk.text)
            .join("")
            .trim(),
        ).toBe(text.trim());
      }
    }),
  );

  it.effect(
    "uses headings, lists and whole fences for large prose while small/non-prose files stay generic",
    () =>
      Effect.gen(function* () {
        const text =
          "# Heading\n\nFirst short paragraph.\n\n- first item\n- second item\n\n```ts\nconst value = 1;\n```\n\n## Next\nSecond paragraph.";
        const chunks = yield* Stream.runCollect(
          chunkTextStream(text, model(64), {
            config,
            fileInfo: { relPath: "docs/guide.MD", sizeBytes: text.length },
          }),
        );
        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks[0]?.text.startsWith("# Heading")).toBe(true);
        expect(chunks.some((chunk) => chunk.text.includes("- first item\n- second item"))).toBe(
          true,
        );
        expect(chunks.some((chunk) => chunk.text.includes("```ts\nconst value = 1;\n```"))).toBe(
          true,
        );
        expect(
          chunks.every((chunk) => chunk.tokenCount === chunk.text.length && chunk.tokenCount <= 64),
        ).toBe(true);
        expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual(chunks.map((_, index) => index));
        for (const fileInfo of [
          { relPath: "guide.md", sizeBytes: 1 },
          { relPath: "source.ts", sizeBytes: 1000 },
        ]) {
          const generic = yield* Stream.runCollect(
            chunkTextStream(text, model(1000), { config, fileInfo }),
          );
          expect(generic.map((chunk) => chunk.text)).toEqual([text]);
        }
      }),
  );

  it.effect("splits long prose sentences and unbroken text without blank output", () =>
    Effect.gen(function* () {
      for (const text of [
        `${"A long sentence with several words. ".repeat(20)}\n\n${"Another sentence! ".repeat(10)}`,
        "x".repeat(250),
        "x😀".repeat(83),
      ]) {
        const chunks = yield* Stream.runCollect(
          chunkTextStream(text, model(60), {
            config,
            fileInfo: { relPath: "large.txt", sizeBytes: text.length },
          }),
        );
        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.every((chunk) => chunk.text.isWellFormed())).toBe(true);
        expect(
          chunks.every((chunk) => chunk.tokenCount <= 60 && chunk.text.trim().length > 0),
        ).toBe(true);
        expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual(chunks.map((_, index) => index));
        if (!text.includes(" ")) expect(chunks.map((chunk) => chunk.text).join("")).toBe(text);
      }
    }),
  );

  it.effect("uses the context fallback but propagates token-count failures", () =>
    Effect.gen(function* () {
      const failure = new KnowledgeOperationError({
        code: "chunking_failed",
        cause: "tokenizer unavailable",
      });
      const fallback = { ...model(40), getContextLength: () => Effect.fail(failure) };
      const chunks = yield* Stream.runCollect(
        chunkTextStream("x".repeat(100), fallback, { config }),
      );
      expect(chunks.every((chunk) => chunk.tokenCount <= config.fallbackTokenLimit)).toBe(true);
      const failed = yield* Stream.runCollect(
        chunkTextStream("word word", {
          ...model(40),
          countTokens: () => Effect.fail(failure),
        }),
      ).pipe(Effect.flip);
      expect(failed).toBe(failure);
    }),
  );

  it.effect("keeps chunk hashes deterministic and associated with path, ordinal and content", () =>
    Effect.gen(function* () {
      const hash = hashChunk("src/one.ts", 0, "export const value = 1;");
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
      expect(hashChunk("src/one.ts", 0, "export const value = 1;")).toBe(hash);
      expect(hashChunk("src/two.ts", 0, "export const value = 1;")).not.toBe(hash);
      expect(hashChunk("src/one.ts", 1, "export const value = 1;")).not.toBe(hash);
      expect(hashChunk("src/one.ts", 0, "export const value = 2;")).not.toBe(hash);
      const text = "1".repeat(4_427);
      const chunks = yield* Stream.runCollect(
        chunkTextStream(text, model(512), {
          fileInfo: { relPath: "numbers.txt", sizeBytes: text.length },
        }),
      );
      expect(chunks).toHaveLength(12);
      const hashes = chunks.map((chunk) => hashChunk("numbers.txt", chunk.chunkIndex, chunk.text));
      expect(new Set(hashes).size).toBe(chunks.length);
    }),
  );
});
