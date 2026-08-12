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
  validateRunnerAppendInput,
} from "./sqlite_event_outbox_records.js";

type SqliteDatabase = InstanceType<typeof import("node:sqlite").DatabaseSync>;
type Transaction = <T>(operation: () => T) => T;

export interface PendingRunnerIntervention {
  interventionId: string;
  message: Record<string, unknown>;
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
    SELECT payload_json, event_source_seq, claimed_execution_command_id
    FROM runner_intervention_inbox WHERE intervention_id = ?
  `).get(input.interventionId) as {
    payload_json: string;
    event_source_seq: number | null;
    claimed_execution_command_id: string | null;
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
      queuePosition: existing.claimed_execution_command_id === null ? 1 : 0,
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
    if (lifecycle?.execution_state === "running") {
      database.prepare(`
        UPDATE runner_intervention_inbox
        SET claimed_execution_command_id = NULL, claimed_at = NULL
        WHERE claimed_execution_command_id IS NOT NULL
          AND claimed_execution_command_id <> ?
      `).run(lifecycle.execution_command_id);
    } else {
      database.prepare(`
        UPDATE runner_intervention_inbox
        SET claimed_execution_command_id = NULL, claimed_at = NULL
        WHERE claimed_execution_command_id IS NOT NULL
      `).run();
    }
  });
  const rows = database.prepare(`
    SELECT intervention_id, payload_json
    FROM runner_intervention_inbox
    WHERE claimed_execution_command_id IS NULL
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
      SELECT claimed_execution_command_id FROM runner_intervention_inbox
      WHERE intervention_id = ?
    `).get(interventionId) as { claimed_execution_command_id: string | null } | undefined;
    if (!current) return false;
    if (current.claimed_execution_command_id === commandId) return true;
    if (current.claimed_execution_command_id !== null) return false;
    const result = database.prepare(`
      UPDATE runner_intervention_inbox
      SET claimed_execution_command_id = ?, claimed_at = ?
      WHERE intervention_id = ? AND claimed_execution_command_id IS NULL
    `).run(commandId, new Date().toISOString(), interventionId);
    return Number(result.changes) === 1;
  });
}

export function releaseRunnerInterventionClaim(
  database: SqliteDatabase,
  transaction: Transaction,
  interventionId: string,
  commandId: string,
): void {
  transaction(() => {
    database.prepare(`
      UPDATE runner_intervention_inbox
      SET claimed_execution_command_id = NULL, claimed_at = NULL
      WHERE intervention_id = ? AND claimed_execution_command_id = ?
    `).run(interventionId, commandId);
  });
}

export function completeRunnerInterventionClaim(
  database: SqliteDatabase,
  transaction: Transaction,
  commandId: string,
): void {
  transaction(() => {
    database.prepare(`
      DELETE FROM runner_intervention_inbox
      WHERE claimed_execution_command_id = ?
    `).run(commandId);
  });
}
