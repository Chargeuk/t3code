import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE knowledge_sources (
      source_id TEXT PRIMARY KEY,
      root TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      indexed_at TEXT,
      file_count INTEGER NOT NULL DEFAULT 0,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      ast_coverage_json TEXT
    )
  `;
  yield* sql`
    CREATE TABLE knowledge_runs (
      admission_order INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL UNIQUE,
      source_id TEXT NOT NULL REFERENCES knowledge_sources(source_id),
      operation TEXT NOT NULL CHECK (operation IN ('ingest', 'remove')),
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'cleanup', 'completed', 'failed', 'cancelled')),
      stage TEXT,
      current_file TEXT,
      cleanup_intent TEXT,
      embedding_json TEXT,
      embedding_identity_json TEXT,
      counts_json TEXT NOT NULL,
      error_json TEXT,
      admitted_at TEXT NOT NULL,
      started_at TEXT,
      updated_at TEXT NOT NULL,
      finished_at TEXT
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX knowledge_runs_pending_source_idx ON knowledge_runs(source_id)
    WHERE status IN ('queued', 'running', 'cleanup')
  `;
  yield* sql`
    CREATE INDEX knowledge_runs_source_order_idx ON knowledge_runs(source_id, admission_order DESC)
  `;
  yield* sql`
    CREATE INDEX knowledge_runs_queue_idx ON knowledge_runs(status, admission_order)
  `;
  yield* sql`
    CREATE TABLE knowledge_files (
      source_id TEXT NOT NULL REFERENCES knowledge_sources(source_id),
      rel_path TEXT NOT NULL,
      run_id TEXT NOT NULL REFERENCES knowledge_runs(run_id),
      file_hash TEXT NOT NULL,
      PRIMARY KEY (source_id, rel_path)
    )
  `;
  yield* sql`
    CREATE TABLE knowledge_ast_files (
      source_id TEXT NOT NULL REFERENCES knowledge_sources(source_id),
      rel_path TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (source_id, rel_path)
    )
  `;
  yield* sql`
    CREATE TABLE knowledge_embedding_identity (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      identity_json TEXT NOT NULL
    )
  `;
});
