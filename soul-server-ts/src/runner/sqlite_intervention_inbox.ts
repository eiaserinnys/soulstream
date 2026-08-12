import {
  computeEventOutboxPayloadHash,
  type EventOutboxAppendInput,
  type EventOutboxRecord,
} from "../upstream/event_outbox.js";

import type { RunnerBootstrapRecord } from "./sqlite_event_outbox_schema.js";
import { insertRunnerRecord, latestRunnerSequence } from
  "./sqlite_event_outbox_database.js";
import {
  assertRunnerEventFits,
  stringifyRunnerJson,
  validateRunnerAppendInput,
} from "./sqlite_event_outbox_records.js";

type SqliteDatabase = InstanceType<typeof import("node:sqlite").DatabaseSync>;
type Transaction = <T>(operation: () => T) => T;

export interface PendingRunnerIntervention {
  interventionId: string;
  message: Record<string, unknown>;
}

export type RunnerInterventionResolution = "applied" | "not_applied";

export function migrateRunnerInterventionInboxV9(
  database: SqliteDatabase,
  previousVersion: number,
): void {
  if (previousVersion >= 9) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    const columns = database.prepare(
      "PRAGMA table_info(runner_intervention_inbox)",
    ).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "application_state")) {
      database.exec(`
        ALTER TABLE runner_intervention_inbox
        ADD COLUMN application_state TEXT NOT NULL DEFAULT 'pending' CHECK (
          application_state IN ('pending', 'claimed', 'ambiguous')
        )
      `);
    }
    // Always repair the intermediate state left by the former split migration:
    // ALTER may already exist while backfill and user_version are still v8.
    database.prepare(`
      UPDATE runner_intervention_inbox SET application_state = 'claimed'
      WHERE application_state = 'pending'
        AND claimed_execution_command_id IS NOT NULL
    `).run();
    database.exec("PRAGMA user_version = 9");
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function stageRunnerIntervention(
  database: SqliteDatabase,
  transaction: Transaction,
  bootstrap: RunnerBootstrapRecord,
  input: {
    interventionId: string;
    message: Record<string, unknown>;
    event?: EventOutboxAppendInput;
    queued: boolean;
    queuedAt: string;
  },
): { eventSourceSeq: number | null; queuePosition: number } {
  if (!input.interventionId) throw new Error("runner intervention id is required");
  if (!input.queued && !input.event) {
    throw new Error("runner intervention stage requires an event or queued input");
  }
  if (input.event) {
    validateRunnerAppendInput(input.event);
    if (input.event.session_id !== bootstrap.session_id) {
      throw new Error("runner intervention event session_id differs from bootstrap record");
    }
  }
  const existing = database.prepare(`
    SELECT payload_json, event_source_seq, claimed_execution_command_id,
           application_state
    FROM runner_intervention_inbox WHERE intervention_id = ?
  `).get(input.interventionId) as {
    payload_json: string;
    event_source_seq: number | null;
    claimed_execution_command_id: string | null;
    application_state: "pending" | "claimed" | "ambiguous";
  } | undefined;
  if (existing) {
    if (existing.payload_json !== JSON.stringify(input.message)) {
      throw new Error("runner intervention id conflicts with durable payload");
    }
    if (input.event && existing.event_source_seq === null) {
      throw new Error("runner intervention receipt conflicts with durable inbox entry");
    }
    return {
      eventSourceSeq: existing.event_source_seq,
      queuePosition: existing.application_state === "pending" ? 1 : 0,
    };
  }

  let eventSourceSeq: number | null = null;
  let queuePosition = 0;
  transaction(() => {
    if (input.event) {
      const sourceSeq = latestRunnerSequence(database) + 1;
      const unsigned = {
        stream_id: bootstrap.stream_id,
        source_seq: sourceSeq,
        ...input.event,
      };
      const eventRecord: EventOutboxRecord = {
        ...unsigned,
        payload_hash: computeEventOutboxPayloadHash(unsigned),
      };
      assertRunnerEventFits(eventRecord);
      insertRunnerRecord(database, "event", eventRecord, null);
      eventSourceSeq = sourceSeq;
    }
    if (input.queued) {
      database.prepare(`
        INSERT INTO runner_intervention_inbox (
          intervention_id, payload_json, event_source_seq, queued_at
        ) VALUES (?, ?, ?, ?)
      `).run(
        input.interventionId,
        JSON.stringify(input.message),
        eventSourceSeq,
        input.queuedAt,
      );
      queuePosition = Number((database.prepare(`
        SELECT COUNT(*) AS count FROM runner_intervention_inbox
        WHERE claimed_execution_command_id IS NULL
      `).get() as { count: number }).count);
    }
  });
  return { eventSourceSeq, queuePosition };
}

export function readPendingRunnerInterventions(
  database: SqliteDatabase,
  transaction: Transaction,
): PendingRunnerIntervention[] {
  const lifecycle = database.prepare(`
    SELECT execution_command_id, execution_state FROM runner_event_outbox
    WHERE record_kind = 'bootstrap'
    UNION ALL
    SELECT execution_command_id, execution_state FROM runner_prebootstrap_lifecycle
    WHERE singleton = 1
    LIMIT 1
  `).get() as {
    execution_command_id: string;
    execution_state: string;
  } | undefined;
  transaction(() => {
    if (lifecycle?.execution_state === "completed") {
      // v8 could commit completed and crash before deleting the claim. The
      // terminal lifecycle is the durable apply receipt; replay would duplicate
      // the user turn and any tool side effects.
      database.prepare(`
        DELETE FROM runner_intervention_inbox
        WHERE application_state = 'claimed'
          AND claimed_execution_command_id = ?
      `).run(lifecycle.execution_command_id);
    }

    // A claim that is not the currently executing command has no proof that
    // backend side effects were absent. Preserve it as a loud ambiguity rather
    // than silently changing an at-least-once delivery into duplicate execution.
    if (lifecycle?.execution_state === "running") {
      database.prepare(`
        UPDATE runner_intervention_inbox SET application_state = 'ambiguous'
        WHERE application_state = 'claimed'
          AND claimed_execution_command_id <> ?
      `).run(lifecycle.execution_command_id);
    } else {
      database.prepare(`
        UPDATE runner_intervention_inbox SET application_state = 'ambiguous'
        WHERE application_state = 'claimed'
      `).run();
    }
  });
  const ambiguous = database.prepare(`
    SELECT intervention_id FROM runner_intervention_inbox
    WHERE application_state = 'ambiguous'
    ORDER BY queued_at, rowid
  `).all() as Array<{ intervention_id: string }>;
  if (ambiguous.length > 0) {
    throw new Error(
      `runner intervention application outcome is ambiguous: ${ambiguous
        .map((row) => row.intervention_id)
        .join(", ")}`,
    );
  }
  const rows = database.prepare(`
    SELECT intervention_id, payload_json
    FROM runner_intervention_inbox
    WHERE application_state = 'pending'
      AND claimed_execution_command_id IS NULL
    ORDER BY queued_at, rowid
  `).all() as Array<{ intervention_id: string; payload_json: string }>;
  return rows.map((row) => ({
    interventionId: row.intervention_id,
    message: JSON.parse(row.payload_json) as Record<string, unknown>,
  }));
}

export function claimRunnerIntervention(
  database: SqliteDatabase,
  transaction: Transaction,
  interventionId: string,
  commandId: string,
): boolean {
  return transaction(() => {
    const current = database.prepare(`
      SELECT claimed_execution_command_id, application_state
      FROM runner_intervention_inbox
      WHERE intervention_id = ?
    `).get(interventionId) as {
      claimed_execution_command_id: string | null;
      application_state: "pending" | "claimed" | "ambiguous";
    } | undefined;
    if (!current) return false;
    if (
      current.application_state === "claimed"
      && current.claimed_execution_command_id === commandId
    ) return true;
    if (current.application_state !== "pending") return false;
    const result = database.prepare(`
      UPDATE runner_intervention_inbox
      SET claimed_execution_command_id = ?, claimed_at = ?, application_state = 'claimed'
      WHERE intervention_id = ? AND claimed_execution_command_id IS NULL
        AND application_state = 'pending'
    `).run(commandId, new Date().toISOString(), interventionId);
    return Number(result.changes) === 1;
  });
}

export function markRunnerInterventionAmbiguous(
  database: SqliteDatabase,
  transaction: Transaction,
  interventionId: string,
  commandId: string,
): void {
  transaction(() => {
    const result = database.prepare(`
      UPDATE runner_intervention_inbox
      SET application_state = 'ambiguous'
      WHERE intervention_id = ? AND claimed_execution_command_id = ?
        AND application_state = 'claimed'
    `).run(interventionId, commandId);
    if (Number(result.changes) !== 1) {
      throw new Error(`runner intervention claim mismatch: ${interventionId}`);
    }
  });
}

export function resolveRunnerInterventionAmbiguity(
  database: SqliteDatabase,
  transaction: Transaction,
  interventionId: string,
  resolution: RunnerInterventionResolution,
): void {
  if (!interventionId) throw new Error("runner intervention id is required");
  transaction(() => {
    const result = resolution === "applied"
      ? database.prepare(`
          DELETE FROM runner_intervention_inbox
          WHERE intervention_id = ? AND application_state = 'ambiguous'
        `).run(interventionId)
      : database.prepare(`
          UPDATE runner_intervention_inbox
          SET application_state = 'pending',
              claimed_execution_command_id = NULL,
              claimed_at = NULL
          WHERE intervention_id = ? AND application_state = 'ambiguous'
        `).run(interventionId);
    if (Number(result.changes) !== 1) {
      throw new Error(`runner intervention is not ambiguous: ${interventionId}`);
    }
  });
}

export function finishRunnerExecutionAndIntervention(
  database: SqliteDatabase,
  transaction: Transaction,
  input: {
    commandId: string;
    interventionId?: string;
    state: "completed" | "failed";
    progressedAt: string;
    terminalError: { code: string; message: string } | null;
  },
): void {
  if (!input.commandId) throw new Error("runner execution command id required");
  if (!Number.isFinite(Date.parse(input.progressedAt))) {
    throw new Error("runner progress timestamp invalid");
  }
  if (input.state === "failed" && input.terminalError === null) {
    throw new Error("failed runner execution requires terminal error");
  }
  if (input.state === "completed" && input.terminalError !== null) {
    throw new Error("completed runner execution cannot contain terminal error");
  }
  const terminalError = input.terminalError === null
    ? null
    : stringifyRunnerJson(input.terminalError, "terminal runner error");
  transaction(() => {
    const assignments = `
      execution_state = ?, progress_seq = progress_seq + 1,
      progress_at = ?, liveness_at = ?, in_flight_tools_json = '[]',
      terminal_error_json = ?
    `;
    let result = database.prepare(`
      UPDATE runner_event_outbox SET ${assignments}
      WHERE record_kind = 'bootstrap' AND execution_command_id = ?
    `).run(
      input.state,
      input.progressedAt,
      input.progressedAt,
      terminalError,
      input.commandId,
    );
    if (Number(result.changes) === 0) {
      result = database.prepare(`
        UPDATE runner_prebootstrap_lifecycle SET ${assignments}
        WHERE singleton = 1 AND execution_command_id = ?
      `).run(
        input.state,
        input.progressedAt,
        input.progressedAt,
        terminalError,
        input.commandId,
      );
    }
    if (Number(result.changes) !== 1) {
      throw new Error(`runner lifecycle command mismatch: ${input.commandId}`);
    }
    if (input.state === "completed" && input.interventionId) {
      const completed = database.prepare(`
        DELETE FROM runner_intervention_inbox
        WHERE application_state = 'claimed'
          AND intervention_id = ?
          AND claimed_execution_command_id = ?
      `).run(input.interventionId, input.commandId);
      if (Number(completed.changes) !== 1) {
        throw new Error(`runner intervention claim mismatch: ${input.interventionId}`);
      }
    } else if (input.state === "failed" && input.interventionId) {
      const ambiguous = database.prepare(`
        UPDATE runner_intervention_inbox SET application_state = 'ambiguous'
        WHERE application_state = 'claimed'
          AND intervention_id = ?
          AND claimed_execution_command_id = ?
      `).run(input.interventionId, input.commandId);
      if (Number(ambiguous.changes) !== 1) {
        throw new Error(`runner intervention claim mismatch: ${input.interventionId}`);
      }
    }
  });
}
