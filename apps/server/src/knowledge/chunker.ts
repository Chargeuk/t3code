// @effect-diagnostics nodeBuiltinImport:off -- Pure path and SHA-256 operations match the reference format.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type {
  KnowledgeChunk,
  KnowledgeChunkingOptions,
  KnowledgeChunkTextStream,
  KnowledgeEmbeddingModel,
} from "./types.ts";

type TokenModel = Pick<KnowledgeEmbeddingModel, "countTokens" | "getContextLength">;
type Candidate = Omit<KnowledgeChunk, "chunkIndex">;

const defaultConfig: KnowledgeChunkingOptions = {
  tokenSafetyMargin: 0.85,
  fallbackTokenLimit: 2048,
  largeTextThresholdBytes: 65536,
};

function splitOnBoundaries(text: string): string[] {
  const boundary = /^(class\s+\w+|function\s+\w+|const\s+\w+\s*=\s*\(|export\s+(function|class))/m;
  const parts: string[] = [];
  let current: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (boundary.test(line) && current.length) {
      parts.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length) parts.push(current.join("\n"));
  return parts;
}

function splitIntoProseBlocks(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;
  const flush = () => {
    const block = current.join("\n").trim();
    if (block.length > 0) blocks.push(block);
    current = [];
  };
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^(?:```|~~~)/.test(trimmed)) {
      if (!inFence && current.length > 0) flush();
      current.push(line);
      inFence = !inFence;
      if (!inFence) flush();
      continue;
    }
    if (inFence) {
      current.push(line);
      continue;
    }
    if (trimmed.length === 0) {
      if (current.length > 0) flush();
      continue;
    }
    if (/^#{1,6}\s+/.test(trimmed)) {
      if (current.length > 0) flush();
      current.push(line);
      continue;
    }
    if (
      /^(?:[-*+]\s+|\d+\.\s+)/.test(trimmed) &&
      current.length > 0 &&
      !/^(?:[-*+]\s+|\d+\.\s+)/.test(current[current.length - 1]!.trim())
    ) {
      flush();
    }
    current.push(line);
  }
  if (current.length > 0) flush();
  return blocks;
}

function findLocalBoundaryCut(text: string, preferredLength: number): string {
  if (text.length <= preferredLength) return text;
  const searchWindow = Math.min(
    text.length,
    Math.max(preferredLength + 128, Math.floor(preferredLength * 1.15)),
  );
  const prefix = text.slice(0, searchWindow);
  const floor = Math.max(32, Math.floor(preferredLength * 0.5));
  const patterns = [
    /\n#{1,6}\s/g,
    /\n(?:```|~~~)/g,
    /\n\s*\n/g,
    /\n(?:[-*+]\s+|\d+\.\s+)/g,
    /(?<=[.!?])\s+/g,
    /\n/g,
    /\s+/g,
  ];
  let bestCut: number | undefined;
  for (const pattern of patterns) {
    for (const match of prefix.matchAll(pattern)) {
      const candidate = match.index + match[0].length;
      if (candidate >= floor && candidate <= preferredLength) bestCut = candidate;
    }
    if (bestCut !== undefined) break;
  }
  return prefix.slice(0, bestCut ?? preferredLength).trimEnd();
}

function sliceToFit(model: TokenModel, text: string, maxTokens: number, local: boolean) {
  // Per-slice effects share the Knowledge.chunkTextStream tracing boundary.
  return Stream.unfold(
    local ? text.trim() : text,
    Effect.fnUntraced(function* (remaining: string) {
      if (remaining.length === 0) return undefined;
      let preferredLength = local
        ? Math.min(remaining.length, Math.max(128, maxTokens * 8))
        : remaining.length;
      let candidate = local ? findLocalBoundaryCut(remaining, preferredLength) : remaining;
      if (local && candidate.trim().length === 0)
        candidate = remaining.slice(0, preferredLength).trim();
      let tokens = yield* model.countTokens(candidate);
      while (tokens > maxTokens && candidate.length > 1) {
        preferredLength = local
          ? Math.max(1, Math.floor(candidate.length * 0.85))
          : Math.max(
              1,
              Math.floor(candidate.length * Math.max(0.3, maxTokens / Math.max(tokens, 1))),
            );
        candidate = local
          ? findLocalBoundaryCut(remaining, preferredLength)
          : candidate.slice(0, preferredLength);
        if (local && candidate.trim().length === 0)
          candidate = remaining.slice(0, preferredLength).trim();
        tokens = yield* model.countTokens(candidate);
      }
      const rest = remaining.slice(candidate.length);
      return [{ text: candidate, tokenCount: tokens }, local ? rest.trimStart() : rest] as const;
    }),
  );
}

function genericChunks(text: string, model: TokenModel, maxTokens: number) {
  return Stream.fromIterable(splitOnBoundaries(text)).pipe(
    Stream.flatMap((piece) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const tokenCount = yield* model.countTokens(piece);
          return tokenCount <= maxTokens
            ? Stream.succeed({ text: piece, tokenCount })
            : sliceToFit(model, piece, Math.floor(maxTokens * 0.85), false);
        }),
      ),
    ),
  );
}

function oversizedProse(block: string, model: TokenModel, maxTokens: number) {
  const sentences =
    block
      .match(/[^.!?\n]+[.!?]+(?:\s+|$)|[^\n]+/g)
      ?.map((part) => part.trim())
      .filter(Boolean) ?? [];
  const units = sentences.length > 1 ? sentences : [block];
  return Stream.fromIterable(units).pipe(
    Stream.flatMap((unit) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const tokenCount = yield* model.countTokens(unit);
          return tokenCount <= maxTokens
            ? Stream.succeed({ text: unit, tokenCount })
            : sliceToFit(model, unit, Math.floor(maxTokens * 0.9), true);
        }),
      ),
    ),
  );
}

function proseChunks(text: string, model: TokenModel, maxTokens: number) {
  return Stream.fromIterable(splitIntoProseBlocks(text)).pipe(
    Stream.mapAccumEffect(
      (): Candidate | undefined => undefined,
      // Block assembly runs inside the Knowledge.chunkTextStream span.
      Effect.fnUntraced(function* (current: Candidate | undefined, block: string) {
        const blockTokens = yield* model.countTokens(block);
        const next = { text: block, tokenCount: blockTokens };
        if (blockTokens > maxTokens) {
          const streams = current ? [Stream.succeed(current)] : [];
          return [undefined, [...streams, oversizedProse(block, model, maxTokens)]] as const;
        }
        if (!current) return [next, []] as const;
        const joined = `${current.text}\n\n${block}`;
        const joinedTokens = yield* model.countTokens(joined);
        if (joinedTokens <= maxTokens)
          return [{ text: joined, tokenCount: joinedTokens }, []] as const;
        return [next, [Stream.succeed(current)]] as const;
      }),
      { onHalt: (current) => (current ? [Stream.succeed(current)] : []) },
    ),
    Stream.flatMap((stream) => stream),
  );
}

export const chunkTextStream: KnowledgeChunkTextStream = (text, model, options) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const config = options?.config ?? defaultConfig;
      const maxTokens = yield* model.getContextLength().pipe(
        Effect.map((context) => Math.floor(context * config.tokenSafetyMargin)),
        Effect.orElseSucceed(() => config.fallbackTokenLimit),
      );
      const fileInfo = options?.fileInfo;
      const ext = fileInfo ? NodePath.extname(fileInfo.relPath).slice(1).toLowerCase() : "";
      const useProse =
        ["md", "mdx", "txt"].includes(ext) &&
        fileInfo !== undefined &&
        fileInfo.sizeBytes >= config.largeTextThresholdBytes;
      return (
        useProse ? proseChunks(text, model, maxTokens) : genericChunks(text, model, maxTokens)
      ).pipe(
        Stream.filter((chunk) => chunk.text.trim().length > 0),
        Stream.map((chunk, chunkIndex) => ({ ...chunk, chunkIndex })),
      );
    }),
  ).pipe(Stream.withSpan("Knowledge.chunkTextStream"));

export function hashChunk(relPath: string, chunkIndex: number, text: string): string {
  return NodeCrypto.createHash("sha256")
    .update(relPath, "utf8")
    .update(String(chunkIndex), "utf8")
    .update(text, "utf8")
    .digest("hex");
}
