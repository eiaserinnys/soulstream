import type { DatabaseSync } from "node:sqlite";

export function ensureRunnerLifecycleColumns(database: DatabaseSync): void {
  for (const table of ["runner_event_outbox", "runner_prebootstrap_lifecycle"]) {
    const existing = new Set((database.prepare(
      `PRAGMA table_info(${table})`,
    ).all() as Array<{ name: string }>).map((column) => column.name));
    for (const [name, declaration] of LIFECYCLE_COLUMNS) {
      if (!existing.has(name)) {
        database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
      }
    }
  }
}

const LIFECYCLE_COLUMNS = [
  ["runner_pid", "INTEGER"],
  ["execution_command_id", "TEXT"],
  ["execution_state", "TEXT CHECK (execution_state IS NULL OR execution_state IN ('running', 'completed', 'failed', 'reaped', 'closed'))"],
  ["progress_seq", "INTEGER NOT NULL DEFAULT 0 CHECK (progress_seq >= 0)"],
  ["progress_at", "TEXT"],
  ["liveness_at", "TEXT"],
  ["in_flight_tools_json", "TEXT CHECK (in_flight_tools_json IS NULL OR json_valid(in_flight_tools_json))"],
  ["terminal_error_json", "TEXT CHECK (terminal_error_json IS NULL OR json_valid(terminal_error_json))"],
] as const;
