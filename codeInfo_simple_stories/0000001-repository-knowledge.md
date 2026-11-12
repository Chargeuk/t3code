# Title

Users can index repositories and manage their code knowledge

# Acceptance

1. Users can add a repository through Knowledge without first registering it as a project.
2. Users can start indexing, see saved progress and errors, and reconnect without losing those summaries.
3. Users can queue repositories while one is indexing, cancel active indexing, and have interrupted work resume after a server restart.
4. Users can refresh an index after files change; unchanged content avoids unnecessary embedding work.
5. Users can retrieve repository-scoped code context with source ranges and structural information for JavaScript, TypeScript, TSX, Python, C#, Rust, and C++.
6. Users can configure file filters, embedding providers, models, and storage settings for their environment, using OpenAI or LM Studio for embeddings.
7. Users use one embedding model across indexed repositories; they can remove indexed content, switch models, and index again.
8. Users retain indexed content across service restarts and can remove indexed content without deleting repository files or source records.

# Description

Repository Knowledge gives T3 Code a reusable source of current code context. Users manage repository indexing and settings through Knowledge, while shared services provide the foundation for later Codebase Questions and automation features. This delivery targets Linux web/server use. Implementation and required automated checks are recorded complete; human acceptance remains pending, and live-provider or native/mobile proof is not claimed.

# Tasks

The numbering matches the executable plan; all 22 tasks are recorded complete.

1. [T3 Code] - Agree contracts and shared ownership.
   - Define Knowledge service and transport contracts and boundaries with later features.

2. [T3 Code] - Implement repository indexing and recovery.
   - Add durable admission, delta indexing, SQLite state, and structural AST extraction.

3. [T3 Code] - Add embeddings, storage, settings, and Knowledge UI.
   - Integrate embedding adapters, model locking, Chroma, and existing client permissions.

4. [T3 Code] - Integrate the feature and record its proof.
   - Verify bundled parser assets, fixture-backed service/UI behavior, persistence, and changed-file checks.

5. [T3 Code] - Record symbol-query and token-counting repairs.
   - Retain completed symbol-ID lookup and literal model-token regressions.

6. [T3 Code] - Record exported-symbol relationship repairs.
   - Retain the parser correction that distinguishes exported declarations from private references.

7. [T3 Code] - Record interrupted-index and file-hash repairs.
   - Retain affected-hash invalidation and hashing of the bytes used for parsing and chunks.

8. [T3 Code] - Record durable worker-notification repairs.
   - Retain interruption-safe admission and worker notification for ingestion and removal.

9. [T3 Code] - Record deleted-file recovery repairs.
   - Retain deletion history until successful cleanup so retries and restored files index correctly.

10. [T3 Code] - Record environment-specific vector storage repairs.
    - Retain collection isolation derived from the persisted environment identity.

11. [T3 Code] - Revalidate Repository Knowledge after review repairs.
    - Record normal build, startup/shutdown, changed-file checks, lint, and formatting.

12. [T3 Code] - Record cancellation and nested-class repairs.
    - Retain interruption-safe cancellation handoff and correct nested-class inheritance ownership.

13. [T3 Code] - Record large-file parsing and chunk-identity repairs.
    - Retain complete parsing of larger TypeScript and distinct vector identities for emitted chunks.

14. [T3 Code] - Revalidate Repository Knowledge after the next review repairs.
    - Record the supported build/runtime/check lifecycle without claiming repository-wide test coverage.

15. [T3 Code] - Record Unicode and generic-inheritance repairs.
    - Retain chunk-text correctness and removal of false generic heritage relationships.

16. [T3 Code] - Record LM Studio client-lifecycle repairs.
    - Retain managed clients for model discovery and embedding resolution.

17. [T3 Code] - Record JavaScript and Rust relationship repairs.
    - Retain JavaScript inheritance and corrected Rust method ranges and caller ownership.

18. [T3 Code] - Revalidate Repository Knowledge after the third review cycle.
    - Record the whole-story build/runtime/check lifecycle and its coverage limits.

19. [T3 Code] - Record development-snapshot isolation repairs.
    - Exclude pending Knowledge runs from development copies while retaining terminal history and index metadata.

20. [T3 Code] - Record dynamic-inheritance and enclosing-caller repairs.
    - Retain parser regressions for TypeScript/TSX factory heritage and long nested functions.

21. [T3 Code] - Record module-function and captured-class repairs.
    - Retain Rust module-function classification and heritage edges for captured class forms.

22. [T3 Code] - Complete final Repository Knowledge revalidation.
    - Record the normal build/runtime/check lifecycle; the final changed-file pass reports 429 tests in 28 files.
