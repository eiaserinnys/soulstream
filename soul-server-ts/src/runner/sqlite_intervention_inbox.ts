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
import { withRunnerSqliteTransactionSync } from "./runner_sqlite_connection.js";

type SqliteDatabase = InstanceType<typeof import("node:sqlite").DatabaseSync>;
type Transaction = <T>(operation: () => T) => Promise<T>;

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
  withRunnerSqliteTransactionSync(database, () => {
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
  }, { transactionLabel: "intervention_inbox.migrate_v9" });
}

export async function stageRunnerIntervention(
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
): Promise<{ eventSourceSeq: number | null; queuePosition: number }> {
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
  await transaction(() => {
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

export async function readPendingRunnerInterventions(
  database: SqliteDatabase,
): Promise<PendingRunnerIntervention[]> {
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
  const unresolved = database.prepare(`
    SELECT intervention_id, application_state, claimed_execution_command_id
    FROM runner_intervention_inbox
    WHERE application_state IN ('claimed', 'ambiguous')
    ORDER BY queued_at, rowid
  `).all() as Array<{
    intervention_id: string;
    application_state: "claimed" | "ambiguous";
    claimed_execution_command_id: string | null;
  }>;
  const ambiguous = unresolved.filter((row) => {
    if (row.application_state === "ambiguous") return true;
    if (row.claimed_execution_command_id !== lifecycle?.execution_command_id) return true;
    // A completed lifecycle is the durable apply receipt. A running lifecycle
    // still owns the claim. Neither needs a parent-side cleanup write.
    return lifecycle.execution_state !== "completed"
      && lifecycle.execution_state !== "running";
  });
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

export async function claimRunnerIntervention(
  database: SqliteDatabase,
  transaction: Transaction,
  interventionId: string,
  commandId: string,
): Promise<boolean> {
  return await transaction(() => {
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

export async function markRunnerInterventionAmbiguous(
  database: SqliteDatabase,
  transaction: Transaction,
  interventionId: string,
  commandId: string,
): Promise<void> {
  await transaction(() => {
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

export async function resolveRunnerInterventionAmbiguity(
  database: SqliteDatabase,
  transaction: Transaction,
  interventionId: string,
  resolution: RunnerInterventionResolution,
): Promise<void> {
  if (!interventionId) throw new Error("runner intervention id is required");
  await transaction(() => {
    const result = resolution === "applied"
      ? database.prepare(`
          DELETE FROM runner_intervention_inbox
          WHERE intervention_id = ? AND application_state IN ('claimed', 'ambiguous')
        `).run(interventionId)
      : database.prepare(`
          UPDATE runner_intervention_inbox
          SET application_state = 'pending',
              claimed_execution_command_id = NULL,
              claimed_at = NULL
          WHERE intervention_id = ? AND application_state IN ('claimed', 'ambiguous')
        `).run(interventionId);
    if (Number(result.changes) !== 1) {
      throw new Error(`runner intervention is not resolvable: ${interventionId}`);
    }
  });
}

export async function finishRunnerExecutionAndIntervention(
  database: SqliteDatabase,
  transaction: Transaction,
  input: {
    commandId: string;
    interventionId?: string;
    state: "completed" | "failed";
    progressedAt: string;
    terminalError: { code: string; message: string } | null;
  },
): Promise<void> {
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
  await transaction(() => {
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
