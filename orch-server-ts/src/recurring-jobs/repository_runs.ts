import type { FolderContentQuerySql } from "../board/folder_content_sql.js";

import { requiredRow, runFromRow, type Row } from "./repository_rows.js";
import type { RecurringJobRun, RecurringRunCreation } from "./types.js";

/** Both writers lost a unique index; the reservation transaction rolls back. */
export class ReservationCollision extends Error {}

export async function insertRun(
  sql: FolderContentQuerySql,
  input: RecurringJobRun,
): Promise<RecurringJobRun | null> {
  const rows = await sql<Row[]>`
    INSERT INTO recurring_job_runs (
      run_id, job_id, trigger, scheduled_for, manual_idempotency_key, session_id,
      job_snapshot, state, reason_code, reason_message, created_at, started_at, finished_at, updated_at
    ) VALUES (
      ${input.runId}, ${input.jobId}, ${input.trigger}, ${input.scheduledFor},
      ${input.manualIdempotencyKey}, ${input.sessionId}, ${sql.json(input.jobSnapshot)},
      ${input.state}, ${input.reasonCode}, ${input.reasonMessage}, ${input.createdAt},
      ${input.startedAt}, ${input.finishedAt}, ${input.updatedAt}
    ) ON CONFLICT DO NOTHING RETURNING *
  `;
  return rows[0] ? runFromRow(rows[0]) : null;
}

export async function createRunWithCollisionLookup(
  sql: FolderContentQuerySql,
  input: RecurringJobRun,
): Promise<RecurringRunCreation> {
  const created = await insertRun(sql, input);
  if (created) return { run: created, created: true };
  const rows = await sql<Row[]>`
    SELECT * FROM recurring_job_runs WHERE job_id = ${input.jobId}
      AND (
        (trigger = 'scheduled' AND ${input.trigger} = 'scheduled'
          AND scheduled_for IS NOT DISTINCT FROM ${input.scheduledFor})
        OR (trigger = 'manual' AND manual_idempotency_key IS NOT DISTINCT FROM ${input.manualIdempotencyKey})
        OR state IN ('queued', 'waiting_for_node', 'dispatching', 'awaiting_session', 'running')
      )
    ORDER BY created_at DESC LIMIT 1
  `;
  return { run: runFromRow(requiredRow(rows, "find recurring run collision")), created: false };
}

export async function createManualRunWithCollisionRecord(
  sql: FolderContentQuerySql,
  input: RecurringJobRun,
): Promise<RecurringRunCreation> {
  const created = await insertRun(sql, input);
  if (created) return { run: created, created: true };

  const repeated = await findManualRunByIdempotency(sql, input.jobId, input.manualIdempotencyKey);
  if (repeated) return { run: repeated, created: false };

  // The first insert lost only the active-run partial unique index. Persist a
  // terminal row for this idempotency key so a retry cannot become a new run
  // after the other active run finishes.
  const overlap = await insertRun(sql, {
    ...input,
    state: "skipped_overlap",
    reasonCode: "OVERLAP_ACTIVE_RUN",
    reasonMessage: "Another active recurring run was reserved while this manual request was being created; no second session was created.",
    finishedAt: input.updatedAt,
  });
  if (overlap) return { run: overlap, created: true };

  const concurrent = await findManualRunByIdempotency(sql, input.jobId, input.manualIdempotencyKey);
  if (concurrent) return { run: concurrent, created: false };
  throw new Error(`manual recurring run collision was not recoverable: ${input.jobId}`);
}

async function findManualRunByIdempotency(
  sql: FolderContentQuerySql,
  jobId: string,
  idempotencyKey: string | null,
): Promise<RecurringJobRun | null> {
  const rows = await sql<Row[]>`
    SELECT * FROM recurring_job_runs
    WHERE job_id = ${jobId} AND trigger = 'manual' AND manual_idempotency_key = ${idempotencyKey}
    LIMIT 1
  `;
  return rows[0] ? runFromRow(rows[0]) : null;
}

export async function cancelAutomaticPendingRunsWith(
  sql: FolderContentQuerySql,
  jobId: string,
  reason: { code: string; message: string },
  now: Date,
): Promise<void> {
  await sql<Row[]>`
    UPDATE recurring_job_runs
    SET state = 'cancelled', reason_code = ${reason.code}, reason_message = ${reason.message},
        finished_at = ${now}, updated_at = ${now}
    WHERE job_id = ${jobId} AND trigger = 'scheduled'
      AND state IN ('queued', 'waiting_for_node')
  `;
}

export async function cancelPendingRunsOnArchiveWith(
  sql: FolderContentQuerySql,
  jobId: string,
  reason: { code: string; message: string },
  now: Date,
): Promise<void> {
  await sql<Row[]>`
    UPDATE recurring_job_runs
    SET state = 'cancelled', reason_code = ${reason.code}, reason_message = ${reason.message},
        finished_at = ${now}, updated_at = ${now}
    WHERE job_id = ${jobId}
      AND state IN ('queued', 'waiting_for_node')
  `;
}
