import {
  FolderContentSqlResolver,
  type FolderContentQuerySql,
} from "../board/folder_content_sql.js";
import type { LiveDbSqlResolver } from "../runtime/live_db_sql.js";

import {
  cancelAutomaticPendingRunsWith,
  cancelPendingRunsOnArchiveWith,
  createManualRunWithCollisionRecord,
  createRunWithCollisionLookup,
  insertRun,
  ReservationCollision,
} from "./repository_runs.js";
import {
  jobFromRow,
  presenceFromRow,
  requiredRow,
  runFromRow,
  type Row,
} from "./repository_rows.js";
import type {
  RecurringJob,
  RecurringJobConflict,
  RecurringJobRepository,
  RecurringJobRun,
  RecurringNodePresence,
  RecurringRunCreation,
} from "./types.js";

export class SqlRecurringJobRepository implements RecurringJobRepository {
  private readonly sqlResolver: FolderContentSqlResolver;

  constructor(resolver: LiveDbSqlResolver) {
    this.sqlResolver = new FolderContentSqlResolver(resolver);
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

  async findJobOwnerEmail(jobId: string): Promise<string | null> {
    const sql = await this.resolveSql();
    const rows = await sql<Row[]>`
      SELECT owner_email FROM recurring_jobs
      WHERE job_id = ${jobId}
      LIMIT 1
    `;
    return rows[0] ? String(rows[0].owner_email) : null;
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

  async listAllJobs(includeArchived = false): Promise<RecurringJob[]> {
    const sql = await this.resolveSql();
    const rows = await sql<Row[]>`
      SELECT * FROM recurring_jobs
      WHERE (${includeArchived} OR archived_at IS NULL)
      ORDER BY archived_at NULLS FIRST, next_run_at NULLS LAST, created_at DESC
    `;
    return rows.map(jobFromRow);
  }

  async createJob(input: RecurringJob): Promise<RecurringJob> {
    const sql = await this.resolveSql();
    const rows = await sql<Row[]>`
      INSERT INTO recurring_jobs (
        job_id, owner_email, execution_caller, name, prompt, schedule_expressions,
        schedule_kind, run_at, event_trigger, event_last_fired_at, timezone, node_id, agent_id, model_preset, model_preset_fallbacks,
        folder_id, enabled, archived_at, late_run_window_seconds, next_run_at,
        version, created_idempotency_key, created_by, updated_by, created_at, updated_at
      ) VALUES (
        ${input.jobId}, ${input.ownerEmail}, ${sql.json(input.executionCaller)},
        ${input.name}, ${input.prompt}, ${sql.json(input.scheduleExpressions)},
        ${input.scheduleKind}, ${input.runAt},
        ${input.eventTrigger == null ? null : sql.json(input.eventTrigger)}, ${input.eventLastFiredAt ?? null},
        ${input.timezone}, ${input.nodeId}, ${input.agentId}, ${input.modelPreset}, ${input.modelPresetFallbacks?.length ? sql.json(input.modelPresetFallbacks) : null},
        ${input.folderId}, ${input.enabled},
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
          run_at = ${input.runAt},
          event_trigger = ${input.eventTrigger == null ? null : sql.json(input.eventTrigger)},
          event_last_fired_at = ${input.eventLastFiredAt ?? null},
          timezone = ${input.timezone}, node_id = ${input.nodeId}, agent_id = ${input.agentId},
          model_preset = ${input.modelPreset}, model_preset_fallbacks = ${input.modelPresetFallbacks?.length ? sql.json(input.modelPresetFallbacks) : null},
          folder_id = ${input.folderId}, enabled = ${input.enabled},
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
      await cancelPendingRunsOnArchiveWith(transaction, jobId, {
        code: "JOB_ARCHIVED",
        message: "The recurring job was archived before this run was sent.",
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

  async listEventJobs(limit: number): Promise<RecurringJob[]> {
    const sql = await this.resolveSql();
    const rows = await sql<Row[]>`
      SELECT * FROM recurring_jobs
      WHERE archived_at IS NULL AND enabled = TRUE AND schedule_kind = 'event'
      ORDER BY created_at LIMIT ${limit}
    `;
    return rows.map(jobFromRow);
  }

  async getNodePresence(nodeId: string): Promise<RecurringNodePresence | null> {
    const sql = await this.resolveSql();
    const rows = await sql<Row[]>`
      SELECT * FROM recurring_node_presence WHERE node_id = ${nodeId} LIMIT 1
    `;
    return rows[0] ? presenceFromRow(rows[0]) : null;
  }

  async upsertNodePresence(presence: RecurringNodePresence): Promise<RecurringNodePresence> {
    const sql = await this.resolveSql();
    const rows = await sql<Row[]>`
      INSERT INTO recurring_node_presence (node_id, episode_started_at, last_seen_at)
      VALUES (${presence.nodeId}, ${presence.episodeStartedAt}, ${presence.lastSeenAt})
      ON CONFLICT (node_id) DO UPDATE
      SET episode_started_at = EXCLUDED.episode_started_at,
          last_seen_at = EXCLUDED.last_seen_at
      RETURNING *
    `;
    return presenceFromRow(requiredRow(rows, "upsert recurring node presence"));
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

  async deleteOnceJob(jobId: string): Promise<boolean> {
    const sql = await this.resolveSql();
    return await sql.begin(async (transaction) => {
      const jobs = await transaction<Row[]>`
        SELECT job_id FROM recurring_jobs
        WHERE job_id = ${jobId}
          AND (
            schedule_kind = 'once'
            OR (schedule_kind = 'event'
              AND COALESCE((event_trigger ->> 'repeat')::boolean, FALSE) = FALSE)
          )
        FOR UPDATE
      `;
      if (!jobs[0]) return false;
      await transaction<Row[]>`DELETE FROM recurring_job_runs WHERE job_id = ${jobId}`;
      const deleted = await transaction<Row[]>`
        DELETE FROM recurring_jobs
        WHERE job_id = ${jobId}
          AND (
            schedule_kind = 'once'
            OR (schedule_kind = 'event'
              AND COALESCE((event_trigger ->> 'repeat')::boolean, FALSE) = FALSE)
          )
        RETURNING job_id
      `;
      return deleted.length > 0;
    });
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
        AND job.archived_at IS NULL
        AND (run.trigger = 'manual' OR job.enabled = TRUE)
      RETURNING run.*
    `;
    return rows[0] ? runFromRow(rows[0]) : null;
  }

  async reserveScheduledRun(input: {
    readonly job: RecurringJob;
    readonly compressedRun?: RecurringJobRun;
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
        if (input.compressedRun) {
          const compressed = await insertRun(transaction, input.compressedRun);
          if (!compressed) throw new ReservationCollision();
        }
        const created = await insertRun(transaction, input.run);
        if (created) return { run: created, created: true };
        throw new ReservationCollision();
      });
    } catch (error) {
      if (error instanceof ReservationCollision) return null;
      throw error;
    }
  }

  async reserveEventRun(input: {
    readonly job: RecurringJob;
    readonly run: RecurringJobRun;
    readonly now: Date;
  }): Promise<RecurringRunCreation | null> {
    const sql = await this.resolveSql();
    try {
      return await sql.begin(async (transaction) => {
        const jobs = await transaction<Row[]>`
          UPDATE recurring_jobs
          SET event_last_fired_at = ${input.now}, version = version + 1, updated_at = ${input.now}
          WHERE job_id = ${input.job.jobId} AND version = ${input.job.version}
            AND archived_at IS NULL AND enabled = TRUE AND schedule_kind = 'event'
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
    sql: FolderContentQuerySql,
    jobId: string,
    ownerEmail: string,
  ): Promise<RecurringJobConflict | null> {
    const rows = await sql<Row[]>`
      SELECT * FROM recurring_jobs WHERE job_id = ${jobId} AND owner_email = ${ownerEmail} LIMIT 1
    `;
    return rows[0] ? { code: "VERSION_CONFLICT", job: jobFromRow(rows[0]) } : null;
  }
}
