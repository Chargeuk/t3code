# Feature parity with CodeInfo2

## Overview

Bring the useful repository knowledge and automation capabilities of CodeInfo2 into T3 Code as integrated T3 features. Reuse and minimally adapt the working CodeInfo2 implementations and definitions, while putting persistence, provider execution, authorization, and client integration through existing T3 services and conventions.

This is a feature implementation plan, not a historical data migration. A new T3 installation starts with fresh T3 state; users configure sources and ingest them again. Reusable definition files are adapted as part of this work. They are distinct from users' prior conversations, credentials, ingestion records, and automation run history.

The product exposes reusable **Agents**, **Routines** (adapted CodeInfo2 commands), and **Pipelines** (adapted CodeInfo2 flows). Repository ingestion and structured AST analysis support a codebase-question agent and MCP interface. Pipeline execution retains CodeInfo2's native step behavior, including direct command execution, nested pipelines, control-flow conditions, reusable agent slots, and parallel waves; prompts alone are not a substitute for executable semantics.

Use T3's existing SQLite database as the authoritative store for source, ingestion, and AST metadata and, where appropriate, automation run state and history. Chroma stores the vector index; it is not authoritative for source records or run history.

Integrate this functionality into T3's existing web/server architecture in useful vertical stages. This plan targets Linux T3 server/agent runtime and web/shared functionality. It does not add a competing application. The already-proven T3 development container is a development prerequisite only; it does not satisfy the product deployment or feature acceptance criteria below.

### Assumptions and implementation guidance

- Keep the implementation KISS: reuse or minimally adapt current CodeInfo2 behavior and existing T3 conventions. Do not add product, runtime, or user gates, approvals, preflights, checks, or restrictions absent from current CodeInfo2 functionality. Simplify an inherited or product check only when current source shows it is redundant and accepted behavior, required correctness, T3 authorization, and required contributor checks remain intact. This does not weaken acceptance criteria or remove inherited CodeInfo2 orchestration review stages. Retain successful applicable proof; repeat it only when material change invalidates it or a required repository check calls for it.
- Use the current CodeInfo2 source and definitions as the parity reference, and verify relevant callers and behavior during implementation. Do not treat the older `t3code-port-research-2026-11-08.md` report as accepted requirements; its recommendations are not automatically in scope.
- Reuse existing T3 orchestration, provider instruction/configuration channels, contracts, MCP/RPC services, database lifecycle, and Docker/Compose patterns. Keep reusable definitions file-based and authoritative; map model, provider, MCP, and settings through the existing T3 configuration channels.
- Retain the current CodeInfo2 embedding provider/model choices, including OpenAI and LM Studio's native SDK embedding path. Match its global embedding-model selection and rebuild behavior; do not introduce simultaneous per-repository embedding spaces.
- Preserve useful CodeInfo2 ingestion include/exclude settings and structural-analysis language coverage. Exclude `.repos` from ingestion by default. AST analysis is structured source analysis, not compiler-grade semantic analysis.
- Keep CodeInfo2 project-specific Kadshow/Jira definitions and integrations out of generic shipped defaults. Preserve the existing `flows/`, `commands/`, and `codeinfo_markdown/` project-workflow files and directories: `t3code_implement_story` is a CodeInfo2-driven project workflow, not T3's native Pipelines feature.
- Run T3 implementation tools through the existing Linux development-container workflow when working from CodeInfo2. Use focused checks during implementation and `vp run check:changed` before a later push; do not run repository-wide suites unless requested. The prior browser proof and container setup establish only development prerequisites, not acceptance of this feature.
- Real OpenAI/LM Studio embedding and provider-dependent behavior can only be verified against configured endpoints, models, and credentials. If these are unavailable, leave that proof pending rather than claiming success. Free Replay remains suitable for general UI flow checks.

## Acceptance Criteria

- [ ] **AC-1 — Repository knowledge:** Users can configure a repository source, ingest it, observe progress/status, cancel, re-ingest, and remove its indexed content from the Knowledge page. T3's SQLite database is authoritative for source and ingestion metadata; Chroma stores the vector index. Existing useful include/exclude behavior remains and `.repos` is excluded by default.
- [ ] **AC-2 — Analysis and questions:** Ingested repositories use CodeInfo2-equivalent structured AST analysis for the supported languages and the selected embedding model. Users can ask repository-scoped codebase questions through T3 agents/chat and the MCP interface and receive answers with source references. Repository selection/scope follows verified CodeInfo2 behavior.
- [ ] **AC-3 — Embeddings:** OpenAI and LM Studio embedding options use the same current CodeInfo2 provider/model choices. LM Studio uses its native SDK embedding path. Changing the globally selected embedding model follows CodeInfo2's rebuild semantics; the implementation does not create simultaneous per-repository model spaces.
- [ ] **AC-4 — Reusable definitions and execution:** Reusable Agents, Routines, and Pipelines are loaded and validated from adapted definition files with descriptions, system prompts/configuration, and Routine references. Users can select and start a named Agent as a T3 thread using its trusted provider profile and system instructions, with model/MCP/settings delivered through existing T3 channels. A Routine can be started independently and runs its CodeInfo2 turn sequence in one conversation, with start/stop/progress/history where CodeInfo2 supports them. Pipeline invocation uses the same Routine execution service. Definitions remain authoritative files; no new definition-editor product is required.
- [ ] **AC-5 — Native pipeline semantics:** Pipelines preserve CodeInfo2's supported native step behaviors and result semantics, including logical and loop conditions, agent-slot reuse and reset, native command-execution steps, nested Pipelines/subflows, parallel waves, and the native pipeline step types found in the verified source inventory. Parity is not reduced to prompt-only steps.
- [ ] **AC-6 — Pipeline lifecycle:** Users can start, stop, resume where CodeInfo2 supports it, and inspect Pipeline run history and progress. State and results use T3's existing database lifecycle. Stop cancels active and pending Pipeline-owned work according to CodeInfo2 behavior; it does not assume detached target containers have stopped. Explicit project Docker commands control target stacks.
- [ ] **AC-7 — Automation UI:** Agents, Routines, and Pipelines and their run controls/history are available in the existing T3 UI. Integration is coherent with current navigation, Settings, and project/environment context rather than a separate competing application.
- [ ] **AC-8 — Knowledge questions UI:** The Knowledge experience lets users select repository scope for questions and ask through T3 agents/chat with returned sources, following CodeInfo2-equivalent scope behavior. Source configuration and ingest lifecycle are covered by AC-1.
- [ ] **AC-9 — Settings and secrets:** Applicable configuration is visible through existing environment/project Settings. Secrets remain server-side and follow T3's established secret handling. Reusable definitions remain file-authoritative.
- [ ] **AC-10 — Linux deployment:** The documented/default product deployment runs the T3 server and agent runtime in a Linux container with the repository mounts and existing Docker CLI/Compose plus daemon/socket access needed for project agents, Routines, and Pipelines to start and stop target codebase containers. Chroma runs as a separate persistent sibling/container independent of CodeInfo2 data.
- [ ] **AC-11 — Persistence and errors:** T3's SQLite database remains authoritative for source, ingestion, and AST metadata and for automation run state/history where appropriate; Chroma stores the vector index. Cancellation, parallel results, provider instruction delivery, and ordinary errors follow T3 persistence and service conventions. Focused tests cover changed behaviors at the lowest useful layer; user-visible flows receive a focused real-client pass.
- [ ] **AC-12 — Definition adaptation and scope:** Required reusable CodeInfo2 definitions and transitively required prompts/helpers are adapted for T3. Project-specific Kadshow/Jira definitions and integrations are not included in generic defaults. Existing CodeInfo2 project-workflow paths remain intact.
- [ ] **AC-13 — Proof and reporting:** Relevant focused server, contract, and UI checks pass; configured real embedding/provider behavior is verified where required endpoints, models, and credentials are available. If unavailable, leave the corresponding acceptance criterion open: pending proof is not feature acceptance. The required changed-files check passes before a later push. No proof is inferred from prior container or browser prerequisite work.

## Out of Scope

- No migration of historical Mongo data, conversations, sessions, prior Pipeline runs, credentials, or CodeInfo2 runtime state. Start with fresh T3 state and re-ingest repository sources.
- Reusable definition-file adaptation is in scope; it is not historical data migration. No historical migration tooling is planned.
- No Windows, macOS, iOS, or Android support, native packaging, or cross-platform proof. The target is Linux web/server/shared functionality.
- No extra user features beyond the accepted parity scope; no new snapshot, authorization, approval, allowlist, ownership-policy, or resource-quota framework beyond normal existing T3 correctness and conventions.
- No generic Docker Engine abstraction, sandbox rewrite, or automatic deletion of target containers or volumes. Docker socket authority is an operational property of the Linux deployment, not a separate feature or invented permission policy. Pipeline cancellation does not silently stop detached containers; explicit project Docker commands control target stacks.
- No semantic-analysis engine/library search, compiler-grade semantic analysis, or unrelated refactors. Do not fix independent CodeInfo2 defects as part of this port.
- No Kadshow/Jira project integrations in generic shipped defaults, no fabricated Jira/GitHub tracking requirements, and no competing application or definition editor.
- No gratuitous renaming of `flows/`, `commands/`, or `codeinfo_markdown/`; those directories support the existing CodeInfo2-driven implementation workflow and are separate from T3's user-facing Pipelines and Routines.

## Implementation

Tasks can proceed in parallel where dependencies permit; focused verification belongs to the task that changes the behavior. Keep each checkbox open until the implementation or proof has actually happened. Reconcile exact source inventory and interfaces against current CodeInfo2 and T3 source before coding; the paths below are navigation anchors, not a claim that every file must change.

### 1. Verify parity surface and map existing architecture

Dependencies: none.

- [ ] Inspect the current reusable definitions under CodeInfo2 `codeinfo_agents/` and relevant prompt/helper dependencies. Identify generic definitions needed for the accepted scope and keep Kadshow/Jira project definitions separate.
- [ ] Inspect CodeInfo2 command execution and schema in `server/src/agents/commandsSchema.ts`, `commandItemExecutor.ts`, and `commandsRunner.ts`; inspect Pipeline schema/runtime in `server/src/flows/flowSchema.ts` and `service.ts`.
- [ ] Inspect CodeInfo2 ingestion and vector behavior in `server/src/ingest/`, embedding providers, `server/src/ast/`, codebase-question MCP tools, agent execution, and LM Studio integration. Record actual step coverage and global model/rebuild behavior from source.
- [ ] Trace definition loading, settings flow, and the current source-to-index lifecycle from user action through persisted state and vector operations; distinguish reusable definitions from runtime records.
- [ ] Identify existing T3 services, contracts, UI entry points, and persistence owners that can host each accepted capability. Record only concrete gaps that prevent reuse.
- [ ] Map these responsibilities to existing T3 orchestration, provider adapters/instruction delivery, contracts, server services/RPC/MCP, persistence/migration conventions, client runtime, web UI, and project Docker/Compose scripts. Prefer existing implementations over new abstractions.
- [ ] Keep the implementation inventory limited to the accepted product scope; distinguish reusable definition adaptation from runtime data migration.
- [ ] Focused verification: confirm the mapping against relevant source definitions and callers before selecting service boundaries; no feature proof is claimed by this inventory.

### 2. Load and run reusable Agents and Routines; adapt Pipeline definitions

Dependencies: 1.

- [ ] Load and validate adapted file-backed Agent, Routine, and Pipeline definitions using the existing CodeInfo2 schemas with only the minimal T3 contract adaptation required.
- [ ] Adapt generic CodeInfo2 agent definitions, trusted provider profiles, system prompts, descriptions, and required transitive prompt/helper files into T3's reusable-definition conventions.
- [ ] Preserve Agent definition discovery and the execution context each Agent needs; adapt paths and configuration to T3 rather than carrying CodeInfo2 host-specific assumptions.
- [ ] Support selecting and starting a named Agent as a T3 thread, delivering its system instructions and trusted provider profile plus model/MCP/settings through existing T3 channels.
- [ ] Adapt reusable command definitions as user-facing **Routines**, preserving their ordered turns and Agent references. Execute each Routine as sequential turns in one conversation, following CodeInfo2 semantics; do not concatenate turns into one prompt or treat a Routine as shell commands.
- [ ] Support standalone Routine start, stop, progress, and history where CodeInfo2 currently supports them. Pipeline calls use the same Routine execution service.
- [ ] Adapt reusable flow definitions as user-facing **Pipelines**, preserving native step kinds and control-flow data rather than translating them into prompt-only descriptions.
- [ ] Keep user-facing names Agents, Routines, and Pipelines while leaving the existing project-workflow directory and filenames intact.
- [ ] Route model/provider/MCP/settings inputs through existing T3 provider and configuration channels. Keep definitions file-based and authoritative.
- [ ] Exclude Kadshow/Jira project definitions and integrations from generic shipped defaults. Leave `flows/`, `commands/`, and `codeinfo_markdown/` project workflow paths intact.
- [ ] Focused verification: validate representative adapted definitions against their schemas; cover Routine prompt ordering and conversation reuse, Agent provider-instruction delivery, and Routine stop behavior at the relevant service layer.

### 3. Add repository ingestion and structured analysis services

Dependencies: 1.

- [ ] Adapt the CodeInfo2 ingestion pipeline to T3 server services and its existing database/lifecycle patterns; retain useful include/exclude settings and default exclusion of `.repos`.
- [ ] Keep source traversal, filtering, chunking, and indexing behavior grounded in CodeInfo2's existing implementation; change only what T3's verified service and storage boundaries require.
- [ ] Keep source, ingestion, and AST metadata authoritative in T3's existing SQLite database and persist only the schema/state needed by these services; do not import CodeInfo2 histories, credentials, or prior run records.
- [ ] Store vector embeddings in Chroma while keeping SQLite authoritative for source and ingestion records. Reuse existing T3 database migration conventions only where schema changes are needed; add no historical-data migration framework.
- [ ] Reuse CodeInfo2's existing AST parser/tooling and supported-language coverage; keep the result at structured AST analysis rather than claiming compiler-grade semantics.
- [ ] Preserve the separation between structural AST information and vector retrieval so question answers can use both without presenting AST output as compiler validation.
- [ ] Confirm AST-derived context and indexed source snippets retain enough file and location information to support useful question answers and citations.
- [ ] Integrate Chroma for the persistent vector index, deployed separately from CodeInfo2 data.
- [ ] Preserve CodeInfo2's current global embedding provider/model choices and model-change rebuild semantics, including OpenAI and LM Studio's native SDK path; do not add per-repository model spaces.
- [ ] Implement source configuration, progress/status, cancellation, re-ingestion, and removal using the accepted Knowledge behavior and existing T3 service/error conventions.
- [ ] Focused verification: test representative ingestion/include-exclude behavior, AST extraction, cancellation/removal, embedding dispatch for available providers, and model-change rebuild behavior. Leave real provider proof pending when its configured endpoint/model/credentials are unavailable.
- [ ] Verify source changes can be re-ingested and removed through the supported service paths without relying on historical CodeInfo2 records.

### 4. Provide repository-scoped codebase questions

Dependencies: 3.

- [ ] Adapt CodeInfo2 codebase-question behavior and its MCP interface to T3's agent/service and MCP/RPC conventions.
- [ ] Reuse the existing T3 service boundary for both chat-driven questions and the MCP entry point so repository selection and source handling have one behavior.
- [ ] Deliver repository context and source references to the selected T3 agent through existing provider instruction channels.
- [ ] Preserve the selected repository boundary throughout retrieval and answer construction; do not silently widen a scoped question to other ingested repositories.
- [ ] Handle missing, empty, or unavailable indexed content through existing T3 error/result patterns, with no invented answer source.
- [ ] Preserve CodeInfo2-equivalent repository selection and scope behavior in the API and UI.
- [ ] Focused verification: exercise a question against an ingested fixture/repository, confirm the selected repository scope is honored, and assert source references are returned through the intended agent/MCP path.

### 5. Implement native Pipeline execution semantics

Dependencies: 1, 2; ingestion task 3 is required for native re-ingestion steps and their acceptance, but independent Pipeline execution work can proceed before it.

- [ ] Adapt the CodeInfo2 Pipeline runtime to T3 services and persisted run state. Preserve supported native step behaviors from the verified inventory rather than implementing only prompt steps.
- [ ] Represent the verified CodeInfo2 step schema with T3 contracts and persisted run events/state using the smallest compatible model; avoid a parallel scheduler or workflow framework.
- [ ] Implement logical and loop conditions, direct command execution, nested Pipelines/subflows, and parallel waves with results returned to the correct parent steps.
- [ ] Preserve each verified native step's inputs, outputs, ordering, and observable status, including condition/loop evaluation, command results, nested context, and parallel wave results associated with their originating steps.
- [ ] Preserve data flow between dependent steps while independent work runs in parallel, and retain reusable agent-slot reuse/reset and provider instruction delivery semantics.
- [ ] Support native re-ingestion steps by composing with the ingestion service from task 3; this behavior depends on task 3 even though the general Pipeline executor does not.
- [ ] Retain the normal T3 provider/authentication and execution behavior; do not invent additional approval or allowlist systems for this feature.
- [ ] Implement start, stop, supported resume, progress, and run-history behavior using T3 persistence and orchestration conventions. Cancellation stops active/pending owned Pipeline work according to CodeInfo2 semantics.
- [ ] Persist lifecycle transitions and step/run results in T3's existing SQLite database boundaries so history survives normal server restarts.
- [ ] Make run state and progress available to the UI from the owning service, including terminal success and failure outcomes supported by the existing T3 patterns.
- [ ] Keep target-container lifecycle explicit: Pipeline stop does not assume detached containers stopped; project Docker commands control those stacks.
- [ ] Focused verification: cover each native step family, condition/loop paths, slot reuse/reset, nested execution, parallel result association, lifecycle/cancellation, persisted history, provider instruction delivery, and ordinary failure behavior with focused tests.

### 6. Integrate Linux container and Chroma deployment defaults

Dependencies: 3, 5.

- [ ] Adapt existing T3 Docker/Compose scripts and deployment patterns for a Linux server/agent runtime with the repository mounts and Docker CLI/Compose plus daemon/socket access required by target project operations.
- [ ] Keep the product deployment definition separate from the already-proven development container and use the repository's existing build and environment conventions.
- [ ] Add/use a dedicated persistent Chroma sibling/container independent from CodeInfo2's state and configured for the ingestion service.
- [ ] Ensure the T3 runtime can reach the Chroma service using its configured deployment address and persistent storage survives normal service restarts.
- [ ] Keep data and container lifecycle aligned with existing T3 operational conventions; do not add a generic engine abstraction or automatic target volume deletion.
- [ ] Document Docker socket authority as an operational consequence of this deployment configuration, without adding a new authorization framework.
- [ ] Focused verification: confirm the documented Compose/runtime wiring starts the T3 and Chroma services and that a scoped project Docker operation can start and stop its target stack.

### 7. Build the Knowledge experience

Dependencies: 3, 4.

- [ ] Add Knowledge UI within existing T3 navigation and design patterns for repository configuration, ingest status/progress, cancellation, re-ingestion, and removal.
- [ ] Present ingestion state and actionable errors from persisted service state; do not infer completion merely from a submitted request.
- [ ] Add repository selection/scope for codebase questions and a path to ask through T3 agents/chat with returned sources.
- [ ] Make the current embedding provider/model selection and source include/exclude settings available through existing Settings surfaces.
- [ ] Surface relevant configuration in existing environment/project Settings and keep secrets server-side under current T3 handling.
- [ ] Focused verification: exercise the main Knowledge lifecycle and a repository-scoped question in a real web client using isolated development state; verify progress, cancellation, errors, and sources at the UI boundary.

### 8. Build the Agents, Routines, and Pipelines experience

Dependencies: 2, 5.

- [ ] Integrate reusable Agents, Routines, and Pipelines into existing T3 navigation and environment/project Settings where appropriate.
- [ ] Keep the user-facing terms and navigation consistent across definition selection, execution, and run history.
- [ ] Show available definitions from their authoritative files and present enough description/run context for users to select the intended reusable Agent, Routine, or Pipeline.
- [ ] Let users select and start a named Agent and run its thread through the Agent execution service.
- [ ] Let users select and run a standalone Routine, including stop and supported progress/result/history views, through the same execution service used by Pipelines.
- [ ] Provide Pipeline start/stop, resume where CodeInfo2 supports it, run history, and progress using native runtime services; preserve the existing project workflow separately.
- [ ] Reflect active, pending, and terminal run state from the service, and expose only lifecycle operations supported by CodeInfo2 and the integrated services.
- [ ] Reuse existing T3 UI and RPC patterns; do not create a separate application or a new definition editor.
- [ ] Focused verification: exercise one representative Agent, Routine, and Pipeline flow in the UI, including visible run progress/history and a stop path, using Replay for general UI behavior.

### 9. Integrate, document, and complete focused proof

Dependencies: 2–8.

- [ ] Review existing T3 navigation, settings, contracts, provider surfaces, MCP access, persistence, and applicable clients for the accepted Linux web/server/shared scope. Resolve only the surfaces affected by this feature.
- [ ] Confirm server-side secret handling, environment/project scope, and any changed contract consumers follow their current T3 owners and conventions.
- [ ] Update only the relevant user/operations/internal documentation for Knowledge, automation definitions, Linux deployment, Docker socket authority, and the difference between project workflow folders and native Pipelines.
- [ ] Keep docs focused on user tasks and durable operational constraints; do not add an implementation inventory or duplicate the plan as a second checklist.
- [ ] Run focused tests for changed server services, contracts, persistence, native execution, and UI behavior; use existing test harnesses and avoid repository-wide suites unless requested.
- [ ] Include focused coverage for cancellation, provider instruction delivery, parallel result association, persistence, and ordinary error behavior where these paths change.
- [ ] Verify configured OpenAI/LM Studio embedding and provider-dependent behavior against real configured endpoints/models/credentials when available; when unavailable, leave the related acceptance criteria open rather than treating pending proof as completion.
- [ ] Execute `npm run container:exec -- vp run check:changed` on the final changed content before a later push. Do not replace it with broader repo-wide checks.
- [ ] Review acceptance criteria against actual implementation and evidence; keep incomplete behaviors and unavailable external proof unchecked and report them plainly.

### Implementation Notes
