import type * as Knowledge from "../../../../packages/contracts/src/knowledge.ts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export interface KnowledgeFileFilters {
  readonly includes: ReadonlyArray<string>;
  readonly excludes: ReadonlyArray<string>;
}

export interface KnowledgeDiscoveredFile {
  readonly absPath: string;
  readonly relPath: string;
  readonly ext: string;
  readonly size: number;
}

export interface KnowledgeChunk {
  readonly chunkIndex: number;
  readonly text: string;
  readonly tokenCount: number;
}

export interface KnowledgeChunkingOptions {
  readonly tokenSafetyMargin: number;
  readonly fallbackTokenLimit: number;
  readonly largeTextThresholdBytes: number;
}

// A resolved model captures endpoint/credentials in memory for one attempt, never in a run row.
export interface KnowledgeEmbeddingModel {
  readonly selection: Knowledge.KnowledgeEmbeddingSelection;
  readonly effectiveBatchSize: number;
  readonly countTokens: (text: string) => Effect.Effect<number, Knowledge.KnowledgeOperationError>;
  readonly getContextLength: () => Effect.Effect<number, Knowledge.KnowledgeOperationError>;
  // Exactly one vector per input, in input order, including when SDK batches finish concurrently.
  readonly embedBatch: (
    texts: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<ReadonlyArray<number>>, Knowledge.KnowledgeOperationError>;
}

export type KnowledgeChunkTextStream = (
  text: string,
  model: Pick<KnowledgeEmbeddingModel, "countTokens" | "getContextLength">,
  options?: {
    readonly config?: KnowledgeChunkingOptions;
    readonly fileInfo?: { readonly relPath: string; readonly sizeBytes: number };
  },
) => Stream.Stream<KnowledgeChunk, Knowledge.KnowledgeOperationError>;

export interface KnowledgeAstParseInput extends Knowledge.KnowledgeIndexedFile {
  readonly root: string;
  readonly text: string;
}

export type KnowledgeAstParseResult =
  | {
      readonly status: "ok";
      readonly language: Knowledge.KnowledgeAstLanguage;
      readonly symbols: ReadonlyArray<Knowledge.KnowledgeAstSymbol>;
      readonly references: ReadonlyArray<Knowledge.KnowledgeAstReference>;
      readonly edges: ReadonlyArray<Knowledge.KnowledgeAstEdge>;
      readonly imports: ReadonlyArray<Knowledge.KnowledgeAstModuleImports>;
    }
  | { readonly status: "skipped" }
  | {
      readonly status: "failed";
      readonly language: Knowledge.KnowledgeAstLanguage;
      readonly error: Knowledge.KnowledgeRunFailure;
      readonly range?: Knowledge.KnowledgeAstRange;
    };

export type KnowledgeParseAstSource = (
  input: KnowledgeAstParseInput,
) => Effect.Effect<KnowledgeAstParseResult, Knowledge.KnowledgeOperationError>;
