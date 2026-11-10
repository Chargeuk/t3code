import * as Knowledge from "../../../../packages/contracts/src/knowledge.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const AstFile = Schema.Struct({
  ...Knowledge.KnowledgeIndexedFile.fields,
  symbols: Schema.Array(Knowledge.KnowledgeAstSymbol),
  references: Schema.Array(Knowledge.KnowledgeAstReference),
  edges: Schema.Array(Knowledge.KnowledgeAstEdge),
  imports: Knowledge.KnowledgeAstModuleImports,
});
export type KnowledgeAstFile = typeof AstFile.Type;

const EmbeddingSelectionJson = Schema.fromJsonString(Knowledge.KnowledgeEmbeddingSelection);
const EmbeddingIdentityJson = Schema.fromJsonString(Knowledge.KnowledgeEmbeddingIdentity);
const RunCountsJson = Schema.fromJsonString(Knowledge.KnowledgeRunCounts);
const RunFailureJson = Schema.fromJsonString(Knowledge.KnowledgeRunFailure);
const AstCoverageJson = Schema.fromJsonString(Knowledge.KnowledgeAstCoverage);
const AstFileJson = Schema.fromJsonString(AstFile);
const encodeEmbeddingSelection = Schema.encodeEffect(EmbeddingSelectionJson);
const encodeEmbeddingIdentity = Schema.encodeEffect(EmbeddingIdentityJson);
const encodeCounts = Schema.encodeEffect(RunCountsJson);
const encodeFailure = Schema.encodeEffect(RunFailureJson);
const encodeAstFile = Schema.encodeEffect(AstFileJson);
const encodeAstCoverage = Schema.encodeEffect(AstCoverageJson);
const decodeEmbeddingIdentity = Schema.decodeEffect(EmbeddingIdentityJson);
const decodeAstFile = Schema.decodeEffect(AstFileJson);

const RunRow = Schema.Struct({
  admission_order: Schema.Number,
  run_id: Knowledge.KnowledgeRunId,
  source_id: Knowledge.KnowledgeSourceId,
  operation: Knowledge.KnowledgeRunOperation,
  status: Knowledge.KnowledgeRunStatus,
  stage: Schema.NullOr(Knowledge.KnowledgeRunStage),
  current_file: Schema.NullOr(Schema.String),
  cleanup_intent: Schema.NullOr(Knowledge.KnowledgeCleanupIntent),
  embedding_json: Schema.NullOr(EmbeddingSelectionJson),
  embedding_identity_json: Schema.NullOr(EmbeddingIdentityJson),
  counts_json: RunCountsJson,
  error_json: Schema.NullOr(RunFailureJson),
  admitted_at: Schema.String,
  started_at: Schema.NullOr(Schema.String),
  updated_at: Schema.String,
  finished_at: Schema.NullOr(Schema.String),
  queue_position: Schema.NullOr(Schema.Number),
});

const SourceRow = Schema.Struct({
  source_id: Knowledge.KnowledgeSourceId,
  root: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
  indexed_at: Schema.NullOr(Schema.String),
  file_count: Schema.Number,
  chunk_count: Schema.Number,
  ast_coverage_json: Schema.NullOr(AstCoverageJson),
});

const decodeRunRow = Schema.decodeUnknownEffect(RunRow);
const decodeRunSummary = Schema.decodeEffect(Knowledge.KnowledgeRunSummary);
const decodeSourceRow = Schema.decodeUnknownEffect(SourceRow);
const decodeSourceSummary = Schema.decodeEffect(Knowledge.KnowledgeSourceSummary);
const decodeIndexedFiles = Schema.decodeUnknownEffect(Schema.Array(Knowledge.KnowledgeIndexedFile));
const isKnowledgeError = Schema.is(Knowledge.KnowledgeError);

const emptyCounts: Knowledge.KnowledgeRunCounts = {
  discoveredFiles: 0,
  processedFiles: 0,
  addedFiles: 0,
  changedFiles: 0,
  deletedFiles: 0,
  unchangedFiles: 0,
  chunks: 0,
  embeddedChunks: 0,
};

type AdmitInput = {
  readonly sourceId: Knowledge.KnowledgeSourceId;
  readonly runId: Knowledge.KnowledgeRunId;
  readonly root: string;
  readonly operation: Knowledge.KnowledgeRunOperation;
  readonly embedding: Knowledge.KnowledgeEmbeddingSelection | null;
  readonly now: string;
};
type ProgressInput = {
  readonly runId: Knowledge.KnowledgeRunId;
  readonly stage: Knowledge.KnowledgeRunStage;
  readonly currentFile: string | null;
  readonly counts: Knowledge.KnowledgeRunCounts;
  readonly embeddingIdentity: Knowledge.KnowledgeEmbeddingIdentity | null;
  readonly now: string;
};
type FinalizeInput = {
  readonly runId: Knowledge.KnowledgeRunId;
  readonly files: ReadonlyArray<Knowledge.KnowledgeIndexedFile>;
  // Null retains the live AST when discovery found no AST-relevant delta.
  readonly ast: {
    readonly files: ReadonlyArray<KnowledgeAstFile>;
    readonly coverage: Knowledge.KnowledgeAstCoverage;
  } | null;
  readonly counts: Knowledge.KnowledgeRunCounts;
  readonly now: string;
};

export class KnowledgeRepository extends Context.Service<
  KnowledgeRepository,
  {
    readonly list: () => Effect.Effect<Knowledge.KnowledgeSnapshot, Knowledge.KnowledgeError>;
    readonly resolve: (
      target: Knowledge.KnowledgeSourceTarget,
    ) => Effect.Effect<Knowledge.KnowledgeSourceSummary | null, Knowledge.KnowledgeError>;
    readonly getRun: (
      runId: Knowledge.KnowledgeRunId,
    ) => Effect.Effect<Knowledge.KnowledgeRunSummary, Knowledge.KnowledgeError>;
    readonly admit: (
      input: AdmitInput,
    ) => Effect.Effect<
      { readonly run: Knowledge.KnowledgeRunSummary; readonly changed: boolean },
      Knowledge.KnowledgeError
    >;
    readonly claimOldest: (
      now: string,
    ) => Effect.Effect<Knowledge.KnowledgeRunSummary | null, Knowledge.KnowledgeError>;
    readonly recover: (
      now: string,
    ) => Effect.Effect<ReadonlyArray<Knowledge.KnowledgeRunSummary>, Knowledge.KnowledgeError>;
    readonly progress: (input: ProgressInput) => Effect.Effect<boolean, Knowledge.KnowledgeError>;
    readonly beginCleanup: (input: {
      readonly runId: Knowledge.KnowledgeRunId;
      readonly intent: Knowledge.KnowledgeCleanupIntent;
      readonly error: Knowledge.KnowledgeRunFailure | null;
      readonly now: string;
    }) => Effect.Effect<boolean, Knowledge.KnowledgeError>;
    readonly finish: (input: {
      readonly runId: Knowledge.KnowledgeRunId;
      readonly status: "failed" | "cancelled";
      readonly error: Knowledge.KnowledgeRunFailure | null;
      readonly now: string;
    }) => Effect.Effect<boolean, Knowledge.KnowledgeError>;
    readonly finalize: (input: FinalizeInput) => Effect.Effect<boolean, Knowledge.KnowledgeError>;
    readonly clearIndexedContent: (input: {
      readonly runId: Knowledge.KnowledgeRunId;
      readonly unlockEmbeddingIdentity: boolean;
      readonly now: string;
    }) => Effect.Effect<boolean, Knowledge.KnowledgeError>;
    readonly files: (
      sourceId: Knowledge.KnowledgeSourceId,
    ) => Effect.Effect<ReadonlyArray<Knowledge.KnowledgeIndexedFile>, Knowledge.KnowledgeError>;
    readonly astFiles: (
      sourceId: Knowledge.KnowledgeSourceId,
    ) => Effect.Effect<ReadonlyArray<KnowledgeAstFile>, Knowledge.KnowledgeError>;
    readonly getEmbeddingIdentity: () => Effect.Effect<
      Knowledge.KnowledgeEmbeddingIdentity | null,
      Knowledge.KnowledgeError
    >;
    readonly claimEmbeddingIdentity: (
      identity: Knowledge.KnowledgeEmbeddingIdentity,
    ) => Effect.Effect<Knowledge.KnowledgeEmbeddingIdentity, Knowledge.KnowledgeError>;
    // Caller holds the vector semaphore and has confirmed final collection deletion/absence.
    readonly unlockEmbeddingIdentity: () => Effect.Effect<void, Knowledge.KnowledgeError>;
  }
>()("t3/knowledge/KnowledgeRepository") {}

const persistenceError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause): Knowledge.KnowledgeError =>
      isKnowledgeError(cause)
        ? cause
        : new Knowledge.KnowledgeOperationError({ code: "persistence_failed", cause }),
    ),
  );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const readRuns = Effect.fn("KnowledgeRepository.readRuns")(function* (
    runId: Knowledge.KnowledgeRunId | null = null,
  ) {
    const rows = yield* sql`
      SELECT r.*, CASE WHEN r.status = 'queued' THEN
        (SELECT COUNT(*) FROM knowledge_runs q WHERE q.status = 'queued' AND q.admission_order <= r.admission_order)
        ELSE NULL END AS queue_position
      FROM knowledge_runs r WHERE ${runId === null ? sql`r.status IN ('queued', 'running', 'cleanup')` : sql`r.run_id = ${runId}`}
      ORDER BY r.admission_order
    `;
    return yield* Effect.forEach(rows, (raw) =>
      decodeRunRow(raw).pipe(
        Effect.flatMap((r) =>
          decodeRunSummary({
            runId: r.run_id,
            sourceId: r.source_id,
            operation: r.operation,
            admissionOrder: r.admission_order,
            status: r.status,
            queuePosition: r.queue_position,
            stage: r.stage,
            currentFile: r.current_file,
            cleanupIntent: r.cleanup_intent,
            embedding: r.embedding_json,
            embeddingIdentity: r.embedding_identity_json,
            counts: r.counts_json,
            error: r.error_json,
            admittedAt: r.admitted_at,
            startedAt: r.started_at,
            updatedAt: r.updated_at,
            finishedAt: r.finished_at,
          }),
        ),
      ),
    );
  });

  const getRun = Effect.fn("KnowledgeRepository.getRun")(function* (
    runId: Knowledge.KnowledgeRunId,
  ) {
    const run = (yield* readRuns(runId))[0];
    if (!run) return yield* new Knowledge.KnowledgeNotFoundError({ entity: "run", id: runId });
    return run;
  }, persistenceError);

  const readSource = Effect.fn("KnowledgeRepository.readSource")(function* (raw: unknown) {
    const row = yield* decodeSourceRow(raw);
    const runs = yield* sql<{
      run_id: Knowledge.KnowledgeRunId;
    }>`SELECT run_id FROM knowledge_runs WHERE source_id = ${row.source_id} ORDER BY admission_order DESC LIMIT 1`;
    return yield* decodeSourceSummary({
      sourceId: row.source_id,
      root: row.root,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      indexedAt: row.indexed_at,
      fileCount: row.file_count,
      chunkCount: row.chunk_count,
      astCoverage: row.ast_coverage_json,
      latestRun: runs[0] ? yield* getRun(runs[0].run_id) : null,
    });
  });

  const resolve = Effect.fn("KnowledgeRepository.resolve")(function* (
    target: Knowledge.KnowledgeSourceTarget,
  ) {
    const rows =
      "sourceId" in target
        ? yield* sql`SELECT * FROM knowledge_sources WHERE source_id = ${target.sourceId}`
        : yield* sql`SELECT * FROM knowledge_sources WHERE root = ${target.root}`;
    return rows[0] ? yield* readSource(rows[0]) : null;
  }, persistenceError);

  const getEmbeddingIdentity = Effect.fn("KnowledgeRepository.getEmbeddingIdentity")(function* () {
    const rows = yield* sql<{
      identity_json: string;
    }>`SELECT identity_json FROM knowledge_embedding_identity WHERE singleton = 1`;
    return rows[0] ? yield* decodeEmbeddingIdentity(rows[0].identity_json) : null;
  }, persistenceError);

  const list = Effect.fn("KnowledgeRepository.list")(
    function* () {
      const sources = yield* sql`SELECT * FROM knowledge_sources ORDER BY created_at, source_id`;
      return {
        sources: yield* Effect.forEach(sources, readSource),
        embeddingIdentity: yield* getEmbeddingIdentity(),
      };
    },
    sql.withTransaction,
    persistenceError,
  );

  const admit = Effect.fn("KnowledgeRepository.admit")(
    function* (input: AdmitInput) {
      const existing = yield* resolve({ root: input.root });
      if (existing === null) {
        yield* sql`
        INSERT INTO knowledge_sources(source_id, root, created_at, updated_at)
        VALUES (${input.sourceId}, ${input.root}, ${input.now}, ${input.now})
      `;
      }
      const source = existing ?? (yield* resolve({ root: input.root }));
      if (!source)
        return yield* new Knowledge.KnowledgeNotFoundError({ entity: "source", id: input.root });
      const pendingRows = yield* sql<{
        run_id: Knowledge.KnowledgeRunId;
      }>`SELECT run_id FROM knowledge_runs WHERE source_id = ${source.sourceId} AND status IN ('queued', 'running', 'cleanup')`;
      const pending = pendingRows[0] ? yield* getRun(pendingRows[0].run_id) : null;
      if (pending) {
        if (
          input.operation === "remove" ||
          pending.operation === "remove" ||
          pending.status === "cleanup"
        ) {
          return yield* new Knowledge.KnowledgeSourceBusyError({
            sourceId: source.sourceId,
            runId: pending.runId,
          });
        }
        if (pending.status === "queued") {
          const embeddingJson =
            input.embedding === null ? null : yield* encodeEmbeddingSelection(input.embedding);
          yield* sql`UPDATE knowledge_runs SET embedding_json = ${embeddingJson}, updated_at = ${input.now} WHERE run_id = ${pending.runId}`;
        }
        return { run: yield* getRun(pending.runId), changed: pending.status === "queued" };
      }
      const embeddingJson =
        input.embedding === null ? null : yield* encodeEmbeddingSelection(input.embedding);
      const countsJson = yield* encodeCounts(emptyCounts);
      yield* sql`
      INSERT INTO knowledge_runs(run_id, source_id, operation, status, cleanup_intent, embedding_json, counts_json, admitted_at, updated_at)
      VALUES (${input.runId}, ${source.sourceId}, ${input.operation}, 'queued',
        ${input.operation === "remove" ? "remove" : null}, ${embeddingJson},
        ${countsJson}, ${input.now}, ${input.now})
    `;
      return { run: yield* getRun(input.runId), changed: true };
    },
    sql.withTransaction,
    persistenceError,
  );

  const claimOldest = Effect.fn("KnowledgeRepository.claimOldest")(
    function* (now: string) {
      const active =
        yield* sql`SELECT run_id FROM knowledge_runs WHERE status IN ('running', 'cleanup') LIMIT 1`;
      if (active.length > 0) return null;
      const rows = yield* sql<{ run_id: Knowledge.KnowledgeRunId }>`
      UPDATE knowledge_runs SET status = CASE WHEN operation = 'remove' THEN 'cleanup' ELSE 'running' END,
        stage = CASE WHEN operation = 'remove' THEN 'cleanup' ELSE 'discovery' END,
        current_file = NULL, started_at = COALESCE(started_at, ${now}), updated_at = ${now}
      WHERE run_id = (SELECT run_id FROM knowledge_runs WHERE status = 'queued' ORDER BY admission_order LIMIT 1)
      RETURNING run_id
    `;
      return rows[0] ? yield* getRun(rows[0].run_id) : null;
    },
    sql.withTransaction,
    persistenceError,
  );

  const recover = Effect.fn("KnowledgeRepository.recover")(
    function* (now: string) {
      const countsJson = yield* encodeCounts(emptyCounts);
      yield* sql`
      UPDATE knowledge_runs SET status = 'queued', stage = NULL, current_file = NULL,
        counts_json = ${countsJson}, embedding_identity_json = NULL, error_json = NULL, updated_at = ${now}
      WHERE status = 'running'
    `;
      return (yield* readRuns()).filter((r) => r.status === "queued" || r.status === "cleanup");
    },
    sql.withTransaction,
    persistenceError,
  );

  const progress = Effect.fn("KnowledgeRepository.progress")(function* (input: ProgressInput) {
    const countsJson = yield* encodeCounts(input.counts);
    const identityJson =
      input.embeddingIdentity === null
        ? null
        : yield* encodeEmbeddingIdentity(input.embeddingIdentity);
    const rows = yield* sql`
      UPDATE knowledge_runs SET stage = ${input.stage}, current_file = ${input.currentFile}, counts_json = ${countsJson},
        embedding_identity_json = ${identityJson}, updated_at = ${input.now}
      WHERE run_id = ${input.runId} AND status = 'running' RETURNING run_id
    `;
    return rows.length > 0;
  }, persistenceError);

  const beginCleanup: KnowledgeRepository["Service"]["beginCleanup"] = Effect.fn(
    "KnowledgeRepository.beginCleanup",
  )(function* (input: Parameters<KnowledgeRepository["Service"]["beginCleanup"]>[0]) {
    const errorJson = input.error === null ? null : yield* encodeFailure(input.error);
    const rows = yield* sql`
      UPDATE knowledge_runs SET status = 'cleanup', stage = 'cleanup', current_file = NULL,
        cleanup_intent = ${input.intent}, error_json = ${errorJson}, updated_at = ${input.now}
      WHERE run_id = ${input.runId} AND (status = 'running' OR (status = 'cleanup' AND cleanup_intent = ${input.intent})) RETURNING run_id
    `;
    return rows.length > 0;
  }, persistenceError);

  const writeTerminal = Effect.fn("KnowledgeRepository.writeTerminal")(function* (input: {
    readonly runId: Knowledge.KnowledgeRunId;
    readonly status: Knowledge.KnowledgeTerminalStatus;
    readonly error: Knowledge.KnowledgeRunFailure | null;
    readonly now: string;
  }) {
    const errorJson = input.error === null ? null : yield* encodeFailure(input.error);
    const rows = yield* sql`
      UPDATE knowledge_runs SET status = ${input.status}, stage = NULL, current_file = NULL,
        error_json = ${errorJson}, updated_at = ${input.now}, finished_at = ${input.now}
      WHERE run_id = ${input.runId} AND status IN ('running', 'cleanup') RETURNING run_id
    `;
    return rows.length > 0;
  }, persistenceError);

  const finish: KnowledgeRepository["Service"]["finish"] = Effect.fn("KnowledgeRepository.finish")(
    (input: Parameters<KnowledgeRepository["Service"]["finish"]>[0]) => writeTerminal(input),
  );

  const files = Effect.fn("KnowledgeRepository.files")(function* (
    sourceId: Knowledge.KnowledgeSourceId,
  ) {
    const rows =
      yield* sql`SELECT source_id AS sourceId, run_id AS runId, rel_path AS relPath, file_hash AS fileHash FROM knowledge_files WHERE source_id = ${sourceId} ORDER BY rel_path`;
    return yield* decodeIndexedFiles(rows);
  }, persistenceError);

  const astFiles = Effect.fn("KnowledgeRepository.astFiles")(function* (
    sourceId: Knowledge.KnowledgeSourceId,
  ) {
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM knowledge_ast_files WHERE source_id = ${sourceId} ORDER BY rel_path`;
    return yield* Effect.forEach(rows, (r) => decodeAstFile(r.payload_json));
  }, persistenceError);

  const finalize = Effect.fn("KnowledgeRepository.finalize")(
    function* (input: FinalizeInput) {
      const run = yield* getRun(input.runId);
      if (run.status !== "running" || run.operation !== "ingest") return false;
      yield* sql`DELETE FROM knowledge_files WHERE source_id = ${run.sourceId}`;
      for (const file of input.files) {
        if (file.sourceId !== run.sourceId)
          return yield* new Knowledge.KnowledgeOperationError({
            code: "persistence_failed",
            runId: run.runId,
            cause: new Error("File source does not match run"),
          });
        yield* sql`INSERT INTO knowledge_files(source_id, rel_path, run_id, file_hash) VALUES (${run.sourceId}, ${file.relPath}, ${file.runId}, ${file.fileHash})`;
      }
      if (input.ast !== null) {
        yield* sql`DELETE FROM knowledge_ast_files WHERE source_id = ${run.sourceId}`;
        for (const file of input.ast.files) {
          if (file.sourceId !== run.sourceId)
            return yield* new Knowledge.KnowledgeOperationError({
              code: "persistence_failed",
              runId: run.runId,
              cause: new Error("AST source does not match run"),
            });
          const payloadJson = yield* encodeAstFile(file);
          yield* sql`INSERT INTO knowledge_ast_files(source_id, rel_path, payload_json) VALUES (${run.sourceId}, ${file.relPath}, ${payloadJson})`;
        }
        const coverageJson = yield* encodeAstCoverage(input.ast.coverage);
        yield* sql`UPDATE knowledge_sources SET ast_coverage_json = ${coverageJson} WHERE source_id = ${run.sourceId}`;
      }
      yield* sql`UPDATE knowledge_sources SET indexed_at = ${input.now}, updated_at = ${input.now}, file_count = ${input.files.length}, chunk_count = ${input.counts.chunks} WHERE source_id = ${run.sourceId}`;
      const countsJson = yield* encodeCounts(input.counts);
      yield* sql`UPDATE knowledge_runs SET counts_json = ${countsJson} WHERE run_id = ${run.runId}`;
      return yield* writeTerminal({
        runId: run.runId,
        status: "completed",
        error: null,
        now: input.now,
      });
    },
    sql.withTransaction,
    persistenceError,
  );

  const clearIndexedContent: KnowledgeRepository["Service"]["clearIndexedContent"] = Effect.fn(
    "KnowledgeRepository.clearIndexedContent",
  )(
    function* (input: Parameters<KnowledgeRepository["Service"]["clearIndexedContent"]>[0]) {
      const run = yield* getRun(input.runId);
      if (run.status !== "cleanup" || run.cleanupIntent !== "remove") return false;
      yield* sql`DELETE FROM knowledge_files WHERE source_id = ${run.sourceId}`;
      yield* sql`DELETE FROM knowledge_ast_files WHERE source_id = ${run.sourceId}`;
      yield* sql`UPDATE knowledge_sources SET indexed_at = NULL, file_count = 0, chunk_count = 0, ast_coverage_json = NULL, updated_at = ${input.now} WHERE source_id = ${run.sourceId}`;
      if (input.unlockEmbeddingIdentity) yield* unlockEmbeddingIdentity();
      return yield* writeTerminal({
        runId: run.runId,
        status: "completed",
        error: null,
        now: input.now,
      });
    },
    sql.withTransaction,
    persistenceError,
  );

  const claimEmbeddingIdentity = Effect.fn("KnowledgeRepository.claimEmbeddingIdentity")(
    function* (identity: Knowledge.KnowledgeEmbeddingIdentity) {
      const identityJson = yield* encodeEmbeddingIdentity(identity);
      yield* sql`INSERT INTO knowledge_embedding_identity(singleton, identity_json) VALUES (1, ${identityJson}) ON CONFLICT(singleton) DO NOTHING`;
      const locked = yield* getEmbeddingIdentity();
      if (!locked)
        return yield* new Knowledge.KnowledgeOperationError({
          code: "persistence_failed",
          cause: new Error("Embedding identity was not persisted"),
        });
      if (
        locked.selection.provider !== identity.selection.provider ||
        locked.selection.model !== identity.selection.model
      ) {
        return yield* new Knowledge.KnowledgeEmbeddingMismatchError({
          requested: identity.selection,
          locked,
        });
      }
      if (locked.dimensions !== identity.dimensions) {
        return yield* new Knowledge.KnowledgeOperationError({
          code: "embedding_dimensions_mismatch",
          cause: new Error("Embedding dimensions differ from persisted identity"),
        });
      }
      return locked;
    },
    sql.withTransaction,
    persistenceError,
  );

  const unlockEmbeddingIdentity = Effect.fn("KnowledgeRepository.unlockEmbeddingIdentity")(
    function* () {
      yield* sql`DELETE FROM knowledge_embedding_identity WHERE singleton = 1`;
    },
    persistenceError,
  );

  return KnowledgeRepository.of({
    list,
    resolve,
    getRun,
    admit,
    claimOldest,
    recover,
    progress,
    beginCleanup,
    finish,
    finalize,
    clearIndexedContent,
    files,
    astFiles,
    getEmbeddingIdentity,
    claimEmbeddingIdentity,
    unlockEmbeddingIdentity,
  });
});

export const layer = Layer.effect(KnowledgeRepository, make);
