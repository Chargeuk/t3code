import type * as Knowledge from "../../../../packages/contracts/src/knowledge.ts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export class RepositoryKnowledge extends Context.Service<
  RepositoryKnowledge,
  {
    readonly list: (
      input: Knowledge.KnowledgeListInput,
    ) => Effect.Effect<Knowledge.KnowledgeSnapshot, Knowledge.KnowledgeError>;
    readonly embeddingModels: (
      input: Knowledge.KnowledgeEmbeddingModelsInput,
    ) => Effect.Effect<Knowledge.KnowledgeEmbeddingModelsResult, Knowledge.KnowledgeError>;
    // Resolving a root is read-only, including when no Knowledge source exists yet.
    readonly resolve: (
      input: Knowledge.KnowledgeResolveInput,
    ) => Effect.Effect<Knowledge.KnowledgeResolveResult, Knowledge.KnowledgeError>;
    // Start and re-ingest share admission; duplicates keep the pending run's ID and FIFO order.
    readonly admit: (
      input: Knowledge.KnowledgeAdmitInput,
    ) => Effect.Effect<Knowledge.KnowledgeAdmitResult, Knowledge.KnowledgeError>;
    // Only an active ingest can be cancelled; a queued or terminal run returns applied: false.
    readonly cancel: (
      input: Knowledge.KnowledgeCancelInput,
    ) => Effect.Effect<Knowledge.KnowledgeCancelResult, Knowledge.KnowledgeError>;
    // Removal retains the source record and files; its durable cleanup run can be awaited.
    readonly remove: (
      input: Knowledge.KnowledgeRemoveInput,
    ) => Effect.Effect<Knowledge.KnowledgeRemoveResult, Knowledge.KnowledgeError>;
    // Includes queue time and same-run startup retry; failed/cancelled runs are terminal values.
    readonly waitTerminal: (
      input: Knowledge.KnowledgeWaitTerminalInput,
    ) => Effect.Effect<Knowledge.KnowledgeTerminalRun, Knowledge.KnowledgeError>;
    // The first value is the persisted snapshot; subsequent values follow committed changes.
    readonly subscribe: (
      input: Knowledge.KnowledgeSubscribeInput,
    ) => Stream.Stream<Knowledge.KnowledgeSnapshot, Knowledge.KnowledgeError>;
    readonly retrieve: (
      input: Knowledge.KnowledgeRetrieveInput,
    ) => Effect.Effect<Knowledge.KnowledgeRetrieveResult, Knowledge.KnowledgeError>;
    readonly astListSymbols: (
      input: Knowledge.KnowledgeAstListSymbolsInput,
    ) => Effect.Effect<Knowledge.KnowledgeAstListSymbolsResult, Knowledge.KnowledgeError>;
    readonly astFindDefinition: (
      input: Knowledge.KnowledgeAstFindDefinitionInput,
    ) => Effect.Effect<Knowledge.KnowledgeAstFindDefinitionResult, Knowledge.KnowledgeError>;
    readonly astFindReferences: (
      input: Knowledge.KnowledgeAstFindReferencesInput,
    ) => Effect.Effect<Knowledge.KnowledgeAstFindReferencesResult, Knowledge.KnowledgeError>;
    readonly astCallGraph: (
      input: Knowledge.KnowledgeAstCallGraphInput,
    ) => Effect.Effect<Knowledge.KnowledgeAstCallGraphResult, Knowledge.KnowledgeError>;
    readonly astModuleImports: (
      input: Knowledge.KnowledgeAstModuleImportsInput,
    ) => Effect.Effect<Knowledge.KnowledgeAstModuleImportsResult, Knowledge.KnowledgeError>;
  }
>()("t3/knowledge/RepositoryKnowledge") {}
