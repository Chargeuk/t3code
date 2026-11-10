import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

// Source IDs belong to the serving environment and survive indexed-content removal.
export const KnowledgeSourceId = TrimmedNonEmptyString.pipe(Schema.brand("KnowledgeSourceId"));
export type KnowledgeSourceId = typeof KnowledgeSourceId.Type;
export const KnowledgeRunId = TrimmedNonEmptyString.pipe(Schema.brand("KnowledgeRunId"));
export type KnowledgeRunId = typeof KnowledgeRunId.Type;

export const KnowledgeOpenAiEmbeddingModel = Schema.Literals([
  "text-embedding-3-small",
  "text-embedding-3-large",
]);
export type KnowledgeOpenAiEmbeddingModel = typeof KnowledgeOpenAiEmbeddingModel.Type;

export const KnowledgeEmbeddingSelection = Schema.Union([
  Schema.Struct({
    provider: Schema.Literal("openai"),
    model: KnowledgeOpenAiEmbeddingModel,
  }),
  Schema.Struct({
    provider: Schema.Literal("lmstudio"),
    model: TrimmedNonEmptyString,
  }),
]);
export type KnowledgeEmbeddingSelection = typeof KnowledgeEmbeddingSelection.Type;

export const KnowledgeEmbeddingIdentity = Schema.Struct({
  selection: KnowledgeEmbeddingSelection,
  dimensions: PositiveInt,
});
export type KnowledgeEmbeddingIdentity = typeof KnowledgeEmbeddingIdentity.Type;

export const KnowledgeFailureCode = Schema.Literals([
  "source_unavailable",
  "discovery_failed",
  "file_read_failed",
  "chunking_failed",
  "ast_unavailable",
  "ast_parse_failed",
  "embedding_unavailable",
  "embedding_request_failed",
  "embedding_dimensions_mismatch",
  "vector_store_failed",
  "persistence_failed",
  "cleanup_failed",
]);
export type KnowledgeFailureCode = typeof KnowledgeFailureCode.Type;

export const KnowledgeRunFailure = Schema.Struct({
  code: KnowledgeFailureCode,
  // Persist a safe domain message, never an SDK response or stringified defect.
  message: TrimmedNonEmptyString,
  relPath: Schema.NullOr(Schema.String),
});
export type KnowledgeRunFailure = typeof KnowledgeRunFailure.Type;

export const KnowledgeEmbeddingModelsInput = Schema.Struct({});
export type KnowledgeEmbeddingModelsInput = typeof KnowledgeEmbeddingModelsInput.Type;
export const KnowledgeEmbeddingModelsResult = Schema.Struct({
  models: Schema.Array(KnowledgeEmbeddingSelection),
  failures: Schema.Array(
    Schema.Struct({
      provider: Schema.Literals(["openai", "lmstudio"]),
      error: KnowledgeRunFailure,
    }),
  ),
});
export type KnowledgeEmbeddingModelsResult = typeof KnowledgeEmbeddingModelsResult.Type;

export const KnowledgeRunStatus = Schema.Literals([
  "queued",
  "running",
  "cleanup",
  "completed",
  "failed",
  "cancelled",
]);
export type KnowledgeRunStatus = typeof KnowledgeRunStatus.Type;
export const KnowledgeTerminalStatus = Schema.Literals(["completed", "failed", "cancelled"]);
export type KnowledgeTerminalStatus = typeof KnowledgeTerminalStatus.Type;
export const KnowledgeRunOperation = Schema.Literals(["ingest", "remove"]);
export type KnowledgeRunOperation = typeof KnowledgeRunOperation.Type;
export const KnowledgeCleanupIntent = Schema.Literals(["cancel", "remove", "failure"]);
export type KnowledgeCleanupIntent = typeof KnowledgeCleanupIntent.Type;
export const KnowledgeRunStage = Schema.Literals([
  "discovery",
  "chunking",
  "embedding",
  "ast",
  "cleanup",
]);
export type KnowledgeRunStage = typeof KnowledgeRunStage.Type;

export const KnowledgeRunCounts = Schema.Struct({
  discoveredFiles: NonNegativeInt,
  processedFiles: NonNegativeInt,
  addedFiles: NonNegativeInt,
  changedFiles: NonNegativeInt,
  deletedFiles: NonNegativeInt,
  unchangedFiles: NonNegativeInt,
  chunks: NonNegativeInt,
  embeddedChunks: NonNegativeInt,
});
export type KnowledgeRunCounts = typeof KnowledgeRunCounts.Type;

const knowledgeRunFields = {
  runId: KnowledgeRunId,
  sourceId: KnowledgeSourceId,
  operation: KnowledgeRunOperation,
  // Admission order and runId survive queued-input replacement and abandoned-attempt retry.
  admissionOrder: NonNegativeInt,
  queuePosition: Schema.NullOr(PositiveInt),
  stage: Schema.NullOr(KnowledgeRunStage),
  currentFile: Schema.NullOr(Schema.String),
  cleanupIntent: Schema.NullOr(KnowledgeCleanupIntent),
  embedding: Schema.NullOr(KnowledgeEmbeddingSelection),
  embeddingIdentity: Schema.NullOr(KnowledgeEmbeddingIdentity),
  counts: KnowledgeRunCounts,
  error: Schema.NullOr(KnowledgeRunFailure),
  admittedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
};

export const KnowledgeRunSummary = Schema.Struct({
  ...knowledgeRunFields,
  status: KnowledgeRunStatus,
});
export type KnowledgeRunSummary = typeof KnowledgeRunSummary.Type;

export const KnowledgeTerminalRun = Schema.Struct({
  ...knowledgeRunFields,
  status: KnowledgeTerminalStatus,
  queuePosition: Schema.Null,
  finishedAt: IsoDateTime,
});
export type KnowledgeTerminalRun = typeof KnowledgeTerminalRun.Type;

export const KnowledgeAstCoverage = Schema.Struct({
  supportedFileCount: NonNegativeInt,
  skippedFileCount: NonNegativeInt,
  failedFileCount: NonNegativeInt,
  lastIndexedAt: IsoDateTime,
});
export type KnowledgeAstCoverage = typeof KnowledgeAstCoverage.Type;

export const KnowledgeSourceSummary = Schema.Struct({
  sourceId: KnowledgeSourceId,
  root: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  indexedAt: Schema.NullOr(IsoDateTime),
  fileCount: NonNegativeInt,
  chunkCount: NonNegativeInt,
  astCoverage: Schema.NullOr(KnowledgeAstCoverage),
  latestRun: Schema.NullOr(KnowledgeRunSummary),
});
export type KnowledgeSourceSummary = typeof KnowledgeSourceSummary.Type;

export const KnowledgeSourceTarget = Schema.Union([
  Schema.Struct({ sourceId: KnowledgeSourceId }),
  Schema.Struct({ root: TrimmedNonEmptyString }),
]);
export type KnowledgeSourceTarget = typeof KnowledgeSourceTarget.Type;

export const KnowledgeListInput = Schema.Struct({});
export type KnowledgeListInput = typeof KnowledgeListInput.Type;
export const KnowledgeSnapshot = Schema.Struct({
  sources: Schema.Array(KnowledgeSourceSummary),
  embeddingIdentity: Schema.NullOr(KnowledgeEmbeddingIdentity),
});
export type KnowledgeSnapshot = typeof KnowledgeSnapshot.Type;

export const KnowledgeResolveInput = KnowledgeSourceTarget;
export type KnowledgeResolveInput = typeof KnowledgeResolveInput.Type;
export const KnowledgeResolveResult = Schema.Struct({
  root: TrimmedNonEmptyString,
  source: Schema.NullOr(KnowledgeSourceSummary),
});
export type KnowledgeResolveResult = typeof KnowledgeResolveResult.Type;

export const KnowledgeAdmitInput = Schema.Struct({ target: KnowledgeSourceTarget });
export type KnowledgeAdmitInput = typeof KnowledgeAdmitInput.Type;
export const KnowledgeAdmitResult = Schema.Struct({ run: KnowledgeRunSummary });
export type KnowledgeAdmitResult = typeof KnowledgeAdmitResult.Type;

export const KnowledgeCancelInput = Schema.Struct({ runId: KnowledgeRunId });
export type KnowledgeCancelInput = typeof KnowledgeCancelInput.Type;
export const KnowledgeCancelResult = Schema.Struct({
  applied: Schema.Boolean,
  run: KnowledgeRunSummary,
});
export type KnowledgeCancelResult = typeof KnowledgeCancelResult.Type;
export const KnowledgeRemoveInput = Schema.Struct({ sourceId: KnowledgeSourceId });
export type KnowledgeRemoveInput = typeof KnowledgeRemoveInput.Type;
export const KnowledgeRemoveResult = Schema.Struct({ run: KnowledgeRunSummary });
export type KnowledgeRemoveResult = typeof KnowledgeRemoveResult.Type;
export const KnowledgeWaitTerminalInput = Schema.Struct({ runId: KnowledgeRunId });
export type KnowledgeWaitTerminalInput = typeof KnowledgeWaitTerminalInput.Type;
export const KnowledgeSubscribeInput = Schema.Struct({});
export type KnowledgeSubscribeInput = typeof KnowledgeSubscribeInput.Type;

export const KnowledgeIndexedFile = Schema.Struct({
  sourceId: KnowledgeSourceId,
  runId: KnowledgeRunId,
  relPath: Schema.String,
  fileHash: TrimmedNonEmptyString,
});
export type KnowledgeIndexedFile = typeof KnowledgeIndexedFile.Type;

export const KnowledgeChunkDocument = Schema.Struct({
  ...KnowledgeIndexedFile.fields,
  chunkId: TrimmedNonEmptyString,
  chunkHash: TrimmedNonEmptyString,
  chunkIndex: NonNegativeInt,
  tokenCount: NonNegativeInt,
  text: Schema.String,
});
export type KnowledgeChunkDocument = typeof KnowledgeChunkDocument.Type;

export const KnowledgeRetrieveInput = Schema.Struct({
  sourceIds: Schema.Array(KnowledgeSourceId).check(Schema.isMinLength(1)),
  query: TrimmedNonEmptyString,
  limit: PositiveInt,
});
export type KnowledgeRetrieveInput = typeof KnowledgeRetrieveInput.Type;
export const KnowledgeRetrieveResult = Schema.Struct({
  matches: Schema.Array(Schema.Struct({ chunk: KnowledgeChunkDocument, distance: Schema.Finite })),
});
export type KnowledgeRetrieveResult = typeof KnowledgeRetrieveResult.Type;

export const KnowledgeAstLanguage = Schema.Literals([
  "javascript",
  "typescript",
  "tsx",
  "python",
  "c_sharp",
  "rust",
  "cpp",
]);
export type KnowledgeAstLanguage = typeof KnowledgeAstLanguage.Type;
export const KnowledgeAstSymbolKind = Schema.Literals([
  "Module",
  "Class",
  "Function",
  "Method",
  "Interface",
  "TypeAlias",
  "Enum",
  "Property",
]);
export type KnowledgeAstSymbolKind = typeof KnowledgeAstSymbolKind.Type;
export const KnowledgeAstEdgeType = Schema.Literals([
  "DEFINES",
  "CALLS",
  "IMPORTS",
  "EXPORTS",
  "EXTENDS",
  "IMPLEMENTS",
  "REFERENCES_TYPE",
]);
export type KnowledgeAstEdgeType = typeof KnowledgeAstEdgeType.Type;

const knowledgeAstPosition = Schema.Struct({ line: PositiveInt, column: PositiveInt });
// Tree-sitter positions plus one; the end remains exclusive. Chunks have no inferred ranges.
export const KnowledgeAstRange = Schema.Struct({
  start: knowledgeAstPosition,
  end: knowledgeAstPosition,
});
export type KnowledgeAstRange = typeof KnowledgeAstRange.Type;

export const KnowledgeAstSymbol = Schema.Struct({
  ...KnowledgeIndexedFile.fields,
  symbolId: TrimmedNonEmptyString,
  language: KnowledgeAstLanguage,
  kind: KnowledgeAstSymbolKind,
  name: Schema.String,
  range: KnowledgeAstRange,
  container: Schema.optionalKey(Schema.String),
});
export type KnowledgeAstSymbol = typeof KnowledgeAstSymbol.Type;
export const KnowledgeAstReference = Schema.Struct({
  ...KnowledgeIndexedFile.fields,
  symbolId: Schema.optionalKey(TrimmedNonEmptyString),
  name: Schema.String,
  kind: Schema.Literals(["call", "class", "type", "local"]),
  range: KnowledgeAstRange,
});
export type KnowledgeAstReference = typeof KnowledgeAstReference.Type;
export const KnowledgeAstEdge = Schema.Struct({
  ...KnowledgeIndexedFile.fields,
  fromSymbolId: TrimmedNonEmptyString,
  toSymbolId: TrimmedNonEmptyString,
  type: KnowledgeAstEdgeType,
});
export type KnowledgeAstEdge = typeof KnowledgeAstEdge.Type;
export const KnowledgeAstModuleImports = Schema.Struct({
  ...KnowledgeIndexedFile.fields,
  imports: Schema.Array(
    Schema.Struct({ source: Schema.String, names: Schema.Array(Schema.String) }),
  ),
});
export type KnowledgeAstModuleImports = typeof KnowledgeAstModuleImports.Type;

const knowledgeAstSelector = Schema.Union([
  Schema.Struct({ symbolId: TrimmedNonEmptyString }),
  Schema.Struct({ name: TrimmedNonEmptyString, kind: Schema.optionalKey(KnowledgeAstSymbolKind) }),
]);

export const KnowledgeAstListSymbolsInput = Schema.Struct({
  sourceId: KnowledgeSourceId,
  kinds: Schema.optionalKey(Schema.Array(KnowledgeAstSymbolKind)),
  limit: Schema.optionalKey(PositiveInt),
});
export type KnowledgeAstListSymbolsInput = typeof KnowledgeAstListSymbolsInput.Type;
export const KnowledgeAstListSymbolsResult = Schema.Struct({
  symbols: Schema.Array(KnowledgeAstSymbol),
  coverage: KnowledgeAstCoverage,
});
export type KnowledgeAstListSymbolsResult = typeof KnowledgeAstListSymbolsResult.Type;
export const KnowledgeAstFindDefinitionInput = Schema.Struct({
  sourceId: KnowledgeSourceId,
  selector: knowledgeAstSelector,
});
export type KnowledgeAstFindDefinitionInput = typeof KnowledgeAstFindDefinitionInput.Type;
export const KnowledgeAstFindDefinitionResult = Schema.Struct({
  symbol: Schema.NullOr(KnowledgeAstSymbol),
  coverage: KnowledgeAstCoverage,
});
export type KnowledgeAstFindDefinitionResult = typeof KnowledgeAstFindDefinitionResult.Type;
export const KnowledgeAstFindReferencesInput = Schema.Struct({
  sourceId: KnowledgeSourceId,
  selector: Schema.Union([
    Schema.Struct({ symbolId: TrimmedNonEmptyString }),
    Schema.Struct({ name: TrimmedNonEmptyString }),
  ]),
});
export type KnowledgeAstFindReferencesInput = typeof KnowledgeAstFindReferencesInput.Type;
export const KnowledgeAstFindReferencesResult = Schema.Struct({
  references: Schema.Array(KnowledgeAstReference),
  coverage: KnowledgeAstCoverage,
});
export type KnowledgeAstFindReferencesResult = typeof KnowledgeAstFindReferencesResult.Type;
export const KnowledgeAstCallGraphInput = Schema.Struct({
  sourceId: KnowledgeSourceId,
  symbolId: TrimmedNonEmptyString,
  depth: Schema.optionalKey(PositiveInt),
});
export type KnowledgeAstCallGraphInput = typeof KnowledgeAstCallGraphInput.Type;
export const KnowledgeAstCallGraphResult = Schema.Struct({
  nodes: Schema.Array(KnowledgeAstSymbol),
  edges: Schema.Array(KnowledgeAstEdge),
  coverage: KnowledgeAstCoverage,
});
export type KnowledgeAstCallGraphResult = typeof KnowledgeAstCallGraphResult.Type;
export const KnowledgeAstModuleImportsInput = Schema.Struct({
  sourceId: KnowledgeSourceId,
  relPath: Schema.optionalKey(Schema.String),
});
export type KnowledgeAstModuleImportsInput = typeof KnowledgeAstModuleImportsInput.Type;
export const KnowledgeAstModuleImportsResult = Schema.Struct({
  modules: Schema.Array(KnowledgeAstModuleImports),
  coverage: KnowledgeAstCoverage,
});
export type KnowledgeAstModuleImportsResult = typeof KnowledgeAstModuleImportsResult.Type;

export class KnowledgeNotFoundError extends Schema.TaggedError<KnowledgeNotFoundError>()(
  "KnowledgeNotFoundError",
  { entity: Schema.Literals(["source", "run"]), id: TrimmedNonEmptyString },
) {
  override get message(): string {
    return `Knowledge ${this.entity} was not found: ${this.id}`;
  }
}

export class KnowledgeSourceBusyError extends Schema.TaggedError<KnowledgeSourceBusyError>()(
  "KnowledgeSourceBusyError",
  { sourceId: KnowledgeSourceId, runId: KnowledgeRunId },
) {
  override get message(): string {
    return "Wait for this source's ingest or cleanup to finish before removing indexed content.";
  }
}

export class KnowledgeEmbeddingMismatchError extends Schema.TaggedError<KnowledgeEmbeddingMismatchError>()(
  "KnowledgeEmbeddingMismatchError",
  { requested: KnowledgeEmbeddingSelection, locked: KnowledgeEmbeddingIdentity },
) {
  override get message(): string {
    return "Remove indexed content from all Knowledge sources before changing the embedding model.";
  }
}

export class KnowledgeIndexRequiredError extends Schema.TaggedError<KnowledgeIndexRequiredError>()(
  "KnowledgeIndexRequiredError",
  { sourceId: KnowledgeSourceId, index: Schema.Literals(["vectors", "ast"]) },
) {
  override get message(): string {
    return `Ingest this Knowledge source before querying its ${this.index} index.`;
  }
}

export class KnowledgeOperationError extends Schema.TaggedError<KnowledgeOperationError>()(
  "KnowledgeOperationError",
  {
    code: KnowledgeFailureCode,
    sourceId: Schema.optionalKey(KnowledgeSourceId),
    runId: Schema.optionalKey(KnowledgeRunId),
    relPath: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    switch (this.code) {
      case "source_unavailable":
        return "The Knowledge source directory is missing, unreadable, or not a directory.";
      case "discovery_failed":
        return "Could not enumerate the Knowledge source files. Check directory access.";
      case "file_read_failed":
        return "Could not read a Knowledge source file. Check file access and re-ingest.";
      case "chunking_failed":
        return "Could not tokenize or chunk a Knowledge source file.";
      case "ast_unavailable":
        return "The AST grammar or query assets could not be loaded.";
      case "ast_parse_failed":
        return "Could not parse a Knowledge source file. Inspect its syntax.";
      case "embedding_unavailable":
        return "The embedding model is unavailable. Check Knowledge settings and provider access.";
      case "embedding_request_failed":
        return "The embedding request failed. Check provider access and re-ingest.";
      case "embedding_dimensions_mismatch":
        return "The returned embedding dimensions do not match the global Knowledge index.";
      case "vector_store_failed":
        return "The vector store operation failed. Check the configured Chroma service.";
      case "persistence_failed":
        return "Could not persist Knowledge state. Check the environment's SQLite storage.";
      case "cleanup_failed":
        return "Indexed-content cleanup failed. Restore Chroma access before retrying.";
    }
  }
}

export const KnowledgeError = Schema.Union([
  KnowledgeNotFoundError,
  KnowledgeSourceBusyError,
  KnowledgeEmbeddingMismatchError,
  KnowledgeIndexRequiredError,
  KnowledgeOperationError,
]);
export type KnowledgeError = typeof KnowledgeError.Type;
