import {
  KnowledgeAdmitInput,
  KnowledgeAdmitResult,
  KnowledgeAstCallGraphInput,
  KnowledgeAstCallGraphResult,
  KnowledgeAstFindDefinitionInput,
  KnowledgeAstFindDefinitionResult,
  KnowledgeAstFindReferencesInput,
  KnowledgeAstFindReferencesResult,
  KnowledgeAstListSymbolsInput,
  KnowledgeAstListSymbolsResult,
  KnowledgeAstModuleImportsInput,
  KnowledgeAstModuleImportsResult,
  KnowledgeError,
  KnowledgeListInput,
  KnowledgeResolveResult,
  KnowledgeRetrieveInput,
  KnowledgeRetrieveResult,
  KnowledgeSnapshot,
  KnowledgeSourceTarget,
  KnowledgeTerminalRun,
  KnowledgeWaitTerminalInput,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as RepositoryKnowledge from "../knowledge/RepositoryKnowledge.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";

const shared = {
  failure: Schema.Union([KnowledgeError, OrchestratorMcpFailure]),
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    RepositoryKnowledge.RepositoryKnowledge,
  ],
};

const list = Tool.make("t3_knowledge_list", {
  ...shared,
  description: "List this environment's Knowledge sources and persisted indexing progress.",
  parameters: Schema.Struct({
    ...KnowledgeListInput.fields,
    environmentId: OrchestratorMcpEnvironmentTarget,
  }),
  success: KnowledgeSnapshot,
}).annotate(Tool.Readonly, true);

const resolve = Tool.make("t3_knowledge_resolve", {
  ...shared,
  description: "Resolve a Knowledge source ID or server root. Repositories need not be Projects.",
  parameters: Schema.Struct({
    target: KnowledgeSourceTarget,
    environmentId: OrchestratorMcpEnvironmentTarget,
  }),
  success: KnowledgeResolveResult,
}).annotate(Tool.Readonly, true);

const retrieve = Tool.make("t3_knowledge_retrieve", {
  ...shared,
  description:
    "Retrieve chunk documents within sourceIds. Chunks have no exact citation ranges; use AST or inspect source.",
  parameters: Schema.Struct({
    ...KnowledgeRetrieveInput.fields,
    environmentId: OrchestratorMcpEnvironmentTarget,
  }),
  success: KnowledgeRetrieveResult,
}).annotate(Tool.Readonly, true);

const reingest = Tool.make("t3_knowledge_reingest", {
  ...shared,
  description:
    "Admit indexing or re-ingestion of a source. Returns a durable run; wait for terminal status to observe completion.",
  parameters: Schema.Struct({
    ...KnowledgeAdmitInput.fields,
    environmentId: OrchestratorMcpEnvironmentTarget,
  }),
  success: KnowledgeAdmitResult,
}).annotate(Tool.Destructive, true);

const wait = Tool.make("t3_knowledge_wait", {
  ...shared,
  description:
    "Wait for a Knowledge run's terminal result, including queue time. Inspect its status and error.",
  parameters: Schema.Struct({
    ...KnowledgeWaitTerminalInput.fields,
    environmentId: OrchestratorMcpEnvironmentTarget,
  }),
  success: KnowledgeTerminalRun,
}).annotate(Tool.Readonly, true);

const symbols = Tool.make("t3_knowledge_ast_symbols", {
  ...shared,
  description:
    "List structural AST symbols and exact one-based, end-exclusive ranges within a source.",
  parameters: Schema.Struct({
    ...KnowledgeAstListSymbolsInput.fields,
    environmentId: OrchestratorMcpEnvironmentTarget,
  }),
  success: KnowledgeAstListSymbolsResult,
}).annotate(Tool.Readonly, true);

const definition = Tool.make("t3_knowledge_ast_definition", {
  ...shared,
  description: "Find a structural AST definition by symbol ID or name within a source.",
  parameters: Schema.Struct({
    ...KnowledgeAstFindDefinitionInput.fields,
    environmentId: OrchestratorMcpEnvironmentTarget,
  }),
  success: KnowledgeAstFindDefinitionResult,
}).annotate(Tool.Readonly, true);

const references = Tool.make("t3_knowledge_ast_references", {
  ...shared,
  description:
    "Find structural AST references within a source. Results are not compiler-resolved references.",
  parameters: Schema.Struct({
    ...KnowledgeAstFindReferencesInput.fields,
    environmentId: OrchestratorMcpEnvironmentTarget,
  }),
  success: KnowledgeAstFindReferencesResult,
}).annotate(Tool.Readonly, true);

const calls = Tool.make("t3_knowledge_ast_calls", {
  ...shared,
  description:
    "Read structural call edges from a symbol within a source, with supporting symbols and AST coverage.",
  parameters: Schema.Struct({
    ...KnowledgeAstCallGraphInput.fields,
    environmentId: OrchestratorMcpEnvironmentTarget,
  }),
  success: KnowledgeAstCallGraphResult,
}).annotate(Tool.Readonly, true);

const imports = Tool.make("t3_knowledge_ast_imports", {
  ...shared,
  description:
    "Read recorded module imports within a source, optionally filtered by relative path.",
  parameters: Schema.Struct({
    ...KnowledgeAstModuleImportsInput.fields,
    environmentId: OrchestratorMcpEnvironmentTarget,
  }),
  success: KnowledgeAstModuleImportsResult,
}).annotate(Tool.Readonly, true);

export const KnowledgeToolkit = Toolkit.make(
  list,
  resolve,
  retrieve,
  reingest,
  wait,
  symbols,
  definition,
  references,
  calls,
  imports,
);

export const layer = McpToolAccess.toLayer(
  KnowledgeToolkit,
  Effect.gen(function* () {
    const knowledge = yield* RepositoryKnowledge.RepositoryKnowledge;
    return {
      t3_knowledge_list: McpToolAccess.reads(knowledge.list),
      t3_knowledge_resolve: McpToolAccess.reads((input: { target: KnowledgeSourceTarget }) =>
        knowledge.resolve(input.target),
      ),
      t3_knowledge_retrieve: McpToolAccess.reads(knowledge.retrieve),
      t3_knowledge_reingest: McpToolAccess.writes(knowledge.admit, { linkedCallers: "allowed" }),
      t3_knowledge_wait: McpToolAccess.reads(knowledge.waitTerminal),
      t3_knowledge_ast_symbols: McpToolAccess.reads(knowledge.astListSymbols),
      t3_knowledge_ast_definition: McpToolAccess.reads(knowledge.astFindDefinition),
      t3_knowledge_ast_references: McpToolAccess.reads(knowledge.astFindReferences),
      t3_knowledge_ast_calls: McpToolAccess.reads(knowledge.astCallGraph),
      t3_knowledge_ast_imports: McpToolAccess.reads(knowledge.astModuleImports),
    };
  }),
);
