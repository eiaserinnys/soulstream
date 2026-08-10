import type { EventOutboxRecord } from "../upstream/event_outbox.js";

export const RUNNER_EVENT_OUTBOX_SCHEMA_VERSION = 4;
export const RUNNER_BOOTSTRAP_EVENT_TYPE = "runner_bootstrap";

export const RUNNER_IPC_JOURNAL_DDL = `
CREATE TABLE IF NOT EXISTS runner_ipc_journal (
  frame_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  outbox_source_seq INTEGER UNIQUE,
  correlation_id TEXT UNIQUE,
  frame_kind TEXT NOT NULL CHECK (frame_kind IN ('engine_event', 'host_call')),
  host_acked INTEGER NOT NULL DEFAULT 0 CHECK (host_acked IN (0, 1)),
  service TEXT,
  operation TEXT,
  created_at TEXT NOT NULL,
  CHECK (
    (
      frame_kind = 'engine_event'
      AND outbox_source_seq IS NOT NULL
      AND correlation_id IS NULL
      AND service IS NULL
      AND operation IS NULL
    )
    OR
    (
      frame_kind = 'host_call'
      AND outbox_source_seq IS NULL
      AND correlation_id IS NOT NULL
      AND service IS NOT NULL
      AND operation IS NOT NULL
      AND host_acked = 1
    )
  ),
  FOREIGN KEY (outbox_source_seq) REFERENCES runner_event_outbox(source_seq)
) STRICT;
`;

// Additive-only contract: never rename/drop columns or change an existing
// column's meaning. Future revisions may only add nullable/defaulted columns or
// indexes; record_kind meanings are immutable.
// The runner owns one domain event ledger plus one payload-free IPC ordering
// journal. The journal may only reference source_seq and record host apply ACK;
// it is never a second source of domain state.
export const RUNNER_EVENT_OUTBOX_DDL = `
CREATE TABLE IF NOT EXISTS runner_event_outbox (
  source_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  record_kind TEXT NOT NULL CHECK (record_kind IN ('bootstrap', 'event')),
  stream_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  searchable_text TEXT,
  created_at TEXT NOT NULL,
  semantic_dedupe_key TEXT,
  session_effect_json TEXT CHECK (
    session_effect_json IS NULL OR json_valid(session_effect_json)
  ),
  payload_hash TEXT NOT NULL CHECK (
    length(payload_hash) = 64 AND payload_hash = lower(payload_hash)
  ),
  runner_metadata_json TEXT CHECK (
    runner_metadata_json IS NULL OR json_valid(runner_metadata_json)
  ),
  acked_through INTEGER,
  runner_pid INTEGER,
  execution_command_id TEXT,
  execution_state TEXT CHECK (
    execution_state IS NULL OR execution_state IN (
      'running', 'completed', 'failed', 'reaped', 'closed'
    )
  ),
  progress_seq INTEGER NOT NULL DEFAULT 0 CHECK (progress_seq >= 0),
  progress_at TEXT,
  terminal_error_json TEXT CHECK (
    terminal_error_json IS NULL OR json_valid(terminal_error_json)
  ),
  CHECK (
    (
      record_kind = 'bootstrap'
      AND source_seq = 1
      AND event_type = '${RUNNER_BOOTSTRAP_EVENT_TYPE}'
      AND session_effect_json IS NULL
      AND acked_through >= 1
    )
    OR
    (
      record_kind = 'event'
      AND source_seq > 1
      AND acked_through IS NULL
    )
  )
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS runner_event_outbox_one_bootstrap
ON runner_event_outbox(record_kind)
WHERE record_kind = 'bootstrap';

${RUNNER_IPC_JOURNAL_DDL}
`;

export type RunnerResumeMaterial = {
  schema_version: 1;
  /**
   * null is a final no-resume state, never a placeholder for a pending ID.
   * Phase 3 must wait for an ID-bearing backend's actual session ID before it
   * writes bootstrap and before it appends the first event.
   */
  backend_session_id: string | null;
  cwd: string;
  codex_home: string | null;
  rollout_root: string | null;
  code_sha: string;
  snapshot_path: string;
};

export type RunnerBootstrapInput = {
  session_id: string;
  created_at: string;
  resume: RunnerResumeMaterial;
};

export type RunnerBootstrapRecord = EventOutboxRecord & {
  source_seq: 1;
  event_type: typeof RUNNER_BOOTSTRAP_EVENT_TYPE;
  payload: RunnerResumeMaterial;
  searchable_text: null;
  semantic_dedupe_key: null;
  session_effect: null;
};

export type RunnerEventOutboxRow = {
  source_seq: number;
  record_kind: "bootstrap" | "event";
  stream_id: string;
  session_id: string;
  event_type: string;
  payload_json: string;
  searchable_text: string | null;
  created_at: string;
  semantic_dedupe_key: string | null;
  session_effect_json: string | null;
  payload_hash: string;
  runner_metadata_json: string | null;
  acked_through: number | null;
  runner_pid: number | null;
  execution_command_id: string | null;
  execution_state: RunnerExecutionState | null;
  progress_seq: number;
  progress_at: string | null;
  terminal_error_json: string | null;
};

export type RunnerExecutionState =
  | "running"
  | "completed"
  | "failed"
  | "reaped"
  | "closed";

export type RunnerIpcJournalRow = {
  frame_seq: number;
  outbox_source_seq: number | null;
  correlation_id: string | null;
  frame_kind: "engine_event" | "host_call";
  host_acked: 0 | 1;
  service: string | null;
  operation: string | null;
  created_at: string;
};
