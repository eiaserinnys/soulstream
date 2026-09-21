import {
  BoardYjsSqlResolver,
  type BoardYjsQuerySql,
} from "../board-yjs/board_yjs_sql.js";
import type { LiveDbSqlResolver } from "../runtime/live_db_sql.js";

import type {
  RecurringJob,
  RecurringJobConflict,
  RecurringJobRepository,
  RecurringJobRun,
  RecurringRunCreation,
} from "./types.js";

type Row = Record<string, unknown>;

export class SqlRecurringJobRepository implements RecurringJobRepository {
  private readonly sqlResolver: BoardYjsSqlResolver;

  constructor(resolver: LiveDbSqlResolver) {
    this.sqlResolver = new BoardYjsSqlResolver(resolver);
  }

  async findJobForOwner(
    jobId: string,
    ownerEmail: string,
    includeArchived = false,
  ): Promise<RecurringJob | null> {
    const sql = await this.resolveSql();
    const rows = await sql<Row[]>`
      SELECT * FROM recurring_jobs
      WHERE job_id = ${jobId}
        AND owner_email = ${ownerEmail}
        AND (${includeArchived} OR archived_at IS NULL)
      LIMIT 1
    `;
    return rows[0] ? jobFromRow(rows[0]) : null;
  }

  async listJobsForOwner(ownerEmail: string, includeArchived = false): Promise<RecurringJob[]> {
    const sql = await this.resolveSql();
    const rows = await sql<Row[]>`
      SELECT * FROM recurring_jobs
      WHERE owner_email = ${ownerEmail}
        AND (${includeArchived} OR archived_at IS NULL)
      ORDER BY archived_at NULLS FIRST, next_run_at NULLS LAST, created_at DESC
    `;
    return rows.map(jobFromRow);
  }

  async createJob(input: RecurringJob): Promise<RecurringJob> {
    const sql = await this.resolveSql();
    const rows = await sql<Row[]>`
      INSERT INTO recurring_jobs (
        job_id, owner_email, execution_caller, name, prompt, schedule_expressions,
        timezone, node_id, agent_id, model_preset, container_kind, container_id,
        folder_id, enabled, archived_at, late_run_window_seconds, next_run_at,
        version, created_idempotency_key, created_by, updated_by, created_at, updated_at
      ) VALUES (
        ${input.jobId}, ${input.ownerEmail}, ${sql.json(input.executionCaller)},
        ${input.name}, ${input.prompt}, ${sql.json(input.scheduleExpressions)},
        ${input.timezone}, ${input.nodeId}, ${input.agentId}, ${input.modelPreset},
        ${input.container.kind}, ${input.container.id}, ${input.folderId}, ${input.enabled},
        ${input.archivedAt}, ${input.lateRunWindowSeconds}, ${input.nextRunAt},
        ${input.version}, ${input.createdIdempotencyKey}, ${input.createdBy}, ${input.updatedBy},
        ${input.createdAt}, ${input.updatedAt}
      ) RETURNING *
    `;
    return jobFromRow(requiredRow(rows, "create recurring job"));
  }

  async findJobByCreateIdempotency(
    ownerEmail: string,
    idempotencyKey: string,
  ): Promise<RecurringJob | null> {
    const sql = await this.resolveSql();
    const rows = await sql<Row[]>`
      SELECT * FROM recurring_jobs
      WHERE owner_email = ${ownerEmail} AND created_idempotency_key = ${idempotencyKey}
      LIMIT 1
    `;
    return rows[0] ? jobFromRow(rows[0]) : null;
  }

  async updateJob(
    input: RecurringJob,
    expectedVersion: number,
  ): Promise<RecurringJob | RecurringJobConflict> {
    const sql = await this.resolveSql();
    const rows = await sql<Row[]>`
      UPDATE recurring_jobs
      SET execution_caller = ${sql.json(input.executionCaller)},
          name = ${input.name}, prompt = ${input.prompt},
          schedule_expressions = ${sql.json(input.scheduleExpressions)},
          timezone = ${input.timezone}, node_id = ${input.nodeId}, agent_id = ${input.agentId},
          model_preset = ${input.modelPreset}, container_kind = ${input.container.kind},
          container_id = ${input.container.id}, folder_id = ${input.folderId}, enabled = ${input.enabled},
          late_run_window_seconds = ${input.lateRunWindowSeconds}, next_run_at = ${input.nextRunAt},
          version = version + 1, updated_by = ${input.updatedBy}, updated_at = ${input.updatedAt}
      WHERE job_id = ${input.jobId} AND owner_email = ${input.ownerEmail}
        AND archived_at IS NULL AND version = ${expectedVersion}
      RETURNING *
    `;
    if (rows[0]) return jobFromRow(rows[0]);
    return await this.currentOrConflict(input.jobId, input.ownerEmail);
  }

  async archiveJob(
    jobId: string,
    ownerEmail: string,
    expectedVersion: number,
    actorId: string,
    now: Date,
  ): Promise<RecurringJob | RecurringJobConflict | null> {
    const sql = await this.resolveSql();
    return await sql.begin(async (transaction) => {
      const rows = await transaction<Row[]>`
        UPDATE recurring_jobs
        SET archived_at = ${now}, enabled = FALSE, version = version + 1,
            updated_by = ${actorId}, updated_at = ${now}
        WHERE job_id = ${jobId} AND owner_email = ${ownerEmail}
          AND archived_at IS NULL AND version = ${expectedVersion}
        RETURNING *
      `;
      if (!rows[0]) return await this.currentOrConflictWith(transaction, jobId, ownerEmail);
      await cancelAutomaticPendingRunsWith(transaction, jobId, {
        code: "JOB_ARCHIVED",
        message: "The recurring job was archived before this automatic run was sent.",
      }, now);
      return jobFromRow(rows[0]);
    });
  }

  async listRuns(jobId: string, limit: number): Promise<RecurringJobRun[]> {
    const sql = await this.resolveSql();
    const rows = await sql<Row[]>`
      SELECT * FROM recurring_job_runs WHERE job_id = ${jobId}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
    return rows.map(runFromRow);
  }

  async findRunByManualIdempotency(jobId: string, idempotencyKey: string): Promise<RecurringJobRun | null> {
    const sql = await this.resolveSql();
    const rows = await sql<Row[]>`
      SELECT * FROM recurring_job_runs
      WHERE job_id = ${jobId} AND trigger = 'manual' AND manual_idempotency_key = ${idempotencyKey}
      LIMIT 1
    `;
    return rows[0] ? runFromRow(rows[0]) : null;
  }

  async findActiveRun(jobId: string): Promise<RecurringJobRun | null> {
    const sql = await this.resolveSql();
    const rows = await sql<Row[]>`
      SELECT * FROM recurring_job_runs
      WHERE job_id = ${jobId}
        AND state IN ('queued', 'waiting_for_node', 'dispatching', 'awaiting_session', 'running')
      ORDER BY created_at DESC LIMIT 1
    `;
    return rows[0] ? runFromRow(rows[0]) : null;
  }

  async createManualRun(input: RecurringJobRun): Promise<RecurringRunCreation> {
    const sql = await this.resolveSql();
    return await sql.begin(async (transaction) => await createManualRunWithCollisionRecord(transaction, input));
  }

  async listDueJobs(now: Date, limit: number): Promise<RecurringJob[]> {
    const sql = await this.resolveSql();
    const rows = await sql<Row[]>`
      SELECT * FROM recurring_jobs
      WHERE archived_at IS NULL AND enabled = TRUE AND next_run_at <= ${now}
      ORDER BY next_run_at, created_at LIMIT ${limit}
    `;
    return rows.map(jobFromRow);
  }

  async listActiveRuns(limit: number): Promise<RecurringJobRun[]> {
    const sql = await this.resolveSql();
    const rows = await sql<Row[]>`
      SELECT * FROM recurring_job_runs
      WHERE state IN ('queued', 'waiting_for_node', 'dispatching', 'awaiting_session', 'running')
      ORDER BY updated_at LIMIT ${limit}
    `;
    return rows.map(runFromRow);
  }

  async getJob(jobId: string): Promise<RecurringJob | null> {
    const sql = await this.resolveSql();
    const rows = await sql<Row[]>`SELECT * FROM recurring_jobs WHERE job_id = ${jobId} LIMIT 1`;
    return rows[0] ? jobFromRow(rows[0]) : null;
  }

  async getRun(runId: string): Promise<RecurringJobRun | null> {
    const sql = await this.resolveSql();
    const rows = await sql<Row[]>`SELECT * FROM recurring_job_runs WHERE run_id = ${runId} LIMIT 1`;
    return rows[0] ? runFromRow(rows[0]) : null;
  }

  async getRunBySessionId(sessionId: string): Promise<RecurringJobRun | null> {
    const sql = await this.resolveSql();
    const rows = await sql<Row[]>`
      SELECT * FROM recurring_job_runs WHERE session_id = ${sessionId}
      ORDER BY created_at DESC LIMIT 1
    `;
    return rows[0] ? runFromRow(rows[0]) : null;
  }

  async updateRun(
    run: RecurringJobRun,
    expectedState?: RecurringJobRun["state"],
  ): Promise<RecurringJobRun | null> {
    const sql = await this.resolveSql();
    const rows = await sql<Row[]>`
      UPDATE recurring_job_runs
      SET job_snapshot = ${sql.json(run.jobSnapshot)}, state = ${run.state},
          reason_code = ${run.reasonCode}, reason_message = ${run.reasonMessage},
          started_at = ${run.startedAt}, finished_at = ${run.finishedAt}, updated_at = ${run.updatedAt}
      WHERE run_id = ${run.runId}
        AND (${expectedState === undefined} OR state = ${expectedState})
      RETURNING *
    `;
    return rows[0] ? runFromRow(rows[0]) : null;
  }

  async claimRunForDispatch(runId: string, now: Date): Promise<RecurringJobRun | null> {
    const sql = await this.resolveSql();
    const rows = await sql<Row[]>`
      UPDATE recurring_job_runs AS run
      SET state = 'dispatching', reason_code = NULL, reason_message = NULL,
          finished_at = NULL, updated_at = ${now}
      FROM recurring_jobs AS job
      WHERE run.run_id = ${runId}
        AND job.job_id = run.job_id
        AND run.state IN ('queued', 'waiting_for_node')
        AND (
          run.trigger = 'manual'
          OR (job.enabled = TRUE AND job.archived_at IS NULL)
        )
      RETURNING run.*
    `;
    return rows[0] ? runFromRow(rows[0]) : null;
  }

  async reserveScheduledRun(input: {
    readonly job: RecurringJob;
    readonly run: RecurringJobRun;
    readonly nextRunAt: Date | null;
    readonly now: Date;
  }): Promise<RecurringRunCreation | null> {
    const sql = await this.resolveSql();
    try {
      return await sql.begin(async (transaction) => {
        const jobs = await transaction<Row[]>`
          UPDATE recurring_jobs
          SET next_run_at = ${input.nextRunAt}, version = version + 1, updated_at = ${input.now}
          WHERE job_id = ${input.job.jobId} AND version = ${input.job.version}
            AND archived_at IS NULL AND enabled = TRUE
          RETURNING *
        `;
        if (!jobs[0]) return null;
        const created = await insertRun(transaction, input.run);
        if (created) return { run: created, created: true };
        throw new ReservationCollision();
      });
    } catch (error) {
      if (error instanceof ReservationCollision) return null;
      throw error;
    }
  }

  async cancelAutomaticPendingRuns(
    jobId: string,
    reason: { code: string; message: string },
    now: Date,
  ): Promise<void> {
    await cancelAutomaticPendingRunsWith(await this.resolveSql(), jobId, reason, now);
  }

  async createScheduledRun(input: RecurringJobRun): Promise<RecurringRunCreation> {
    return await createRunWithCollisionLookup(await this.resolveSql(), input);
  }

  async advanceJobNextRun(
    jobId: string,
    expectedVersion: number,
    nextRunAt: Date | null,
    now: Date,
  ): Promise<void> {
    const sql = await this.resolveSql();
    await sql<Row[]>`
      UPDATE recurring_jobs SET next_run_at = ${nextRunAt}, version = version + 1, updated_at = ${now}
      WHERE job_id = ${jobId} AND version = ${expectedVersion}
    `;
  }

  private async currentOrConflict(jobId: string, ownerEmail: string): Promise<RecurringJob | RecurringJobConflict> {
    const conflict = await this.currentOrConflictWith(await this.resolveSql(), jobId, ownerEmail);
    if (!conflict) throw new Error(`recurring job disappeared: ${jobId}`);
    return conflict;
  }

  private async resolveSql() {
    return await this.sqlResolver.resolveSql();
  }

  private async currentOrConflictWith(
    sql: BoardYjsQuerySql,
    jobId: string,
    ownerEmail: string,
  ): Promise<RecurringJobConflict | null> {
    const rows = await sql<Row[]>`
      SELECT * FROM recurring_jobs WHERE job_id = ${jobId} AND owner_email = ${ownerEmail} LIMIT 1
    `;
    return rows[0] ? { code: "VERSION_CONFLICT", job: jobFromRow(rows[0]) } : null;
  }
}

async function createRunWithCollisionLookup(
  sql: BoardYjsQuerySql,
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

async function createManualRunWithCollisionRecord(
  sql: BoardYjsQuerySql,
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
  sql: BoardYjsQuerySql,
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

async function insertRun(
  sql: BoardYjsQuerySql,
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

async function cancelAutomaticPendingRunsWith(
  sql: BoardYjsQuerySql,
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

function jobFromRow(row: Row): RecurringJob {
  return {
    jobId: stringValue(row.job_id),
    ownerEmail: stringValue(row.owner_email),
    executionCaller: objectValue(row.execution_caller),
    name: stringValue(row.name),
    prompt: stringValue(row.prompt),
    scheduleExpressions: stringArray(row.schedule_expressions),
    timezone: stringValue(row.timezone),
    nodeId: stringValue(row.node_id),
    agentId: stringValue(row.agent_id),
    modelPreset: nullableString(row.model_preset),
    container: { kind: containerKind(row.container_kind), id: stringValue(row.container_id) },
    folderId: stringValue(row.folder_id),
    enabled: Boolean(row.enabled),
    archivedAt: timestampOrNull(row.archived_at),
    lateRunWindowSeconds: positiveInteger(row.late_run_window_seconds),
    nextRunAt: timestampOrNull(row.next_run_at),
    version: positiveInteger(row.version),
    createdIdempotencyKey: stringValue(row.created_idempotency_key),
    createdBy: stringValue(row.created_by),
    updatedBy: stringValue(row.updated_by),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function runFromRow(row: Row): RecurringJobRun {
  return {
    runId: stringValue(row.run_id), jobId: stringValue(row.job_id),
    trigger: row.trigger === "manual" ? "manual" : "scheduled",
    scheduledFor: timestampOrNull(row.scheduled_for),
    manualIdempotencyKey: nullableString(row.manual_idempotency_key),
    sessionId: stringValue(row.session_id), jobSnapshot: objectValue(row.job_snapshot),
    state: stringValue(row.state) as RecurringJobRun["state"],
    reasonCode: nullableString(row.reason_code), reasonMessage: nullableString(row.reason_message),
    createdAt: timestamp(row.created_at), startedAt: timestampOrNull(row.started_at),
    finishedAt: timestampOrNull(row.finished_at), updatedAt: timestamp(row.updated_at),
  };
}

function requiredRow(rows: readonly Row[], operation: string): Row {
  if (!rows[0]) throw new Error(`${operation} did not return a row`);
  return rows[0];
}
function stringValue(value: unknown): string { if (typeof value !== "string") throw new Error("invalid recurring job row"); return value; }
function nullableString(value: unknown): string | null { return value === null || value === undefined ? null : stringValue(value); }
function objectValue(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid recurring job JSON"); return value as Record<string, unknown>; }
function stringArray(value: unknown): string[] { if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("invalid recurring schedule array"); return [...value] as string[]; }
function positiveInteger(value: unknown): number { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("invalid recurring integer"); return parsed; }
function timestamp(value: unknown): string { const date = value instanceof Date ? value : new Date(String(value)); if (!Number.isFinite(date.getTime())) throw new Error("invalid recurring timestamp"); return date.toISOString(); }
function timestampOrNull(value: unknown): string | null { return value === null || value === undefined ? null : timestamp(value); }
function containerKind(value: unknown): "folder" | "task" { if (value === "folder" || value === "task") return value; throw new Error("invalid recurring container"); }

class ReservationCollision extends Error {}
