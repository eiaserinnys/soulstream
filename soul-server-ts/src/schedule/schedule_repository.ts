import type { SqlClient } from "../db/session_db.js";

import type {
  CancelScheduleResult,
  ClaimedSchedule,
  ScheduleCreateInput,
  SoulstreamSchedule,
  SoulstreamScheduleKind,
  SoulstreamScheduleStatus,
} from "./schedule_models.js";

interface ScheduleRow {
  schedule_id: string;
  session_id: string;
  kind: SoulstreamScheduleKind;
  status: SoulstreamScheduleStatus;
  prompt: string;
  source_tool: string;
  tool_use_id: string | null;
  cron_expression: string | null;
  run_once_at: Date | string | null;
  timezone: string;
  recurring: boolean;
  next_run_at: Date | string | null;
  last_fired_at: Date | string | null;
  fired_count: number | string;
  last_error: string | null;
  claim_token: string | null;
  claimed_until: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface CancelScheduleRow extends ScheduleRow {
  outcome: "cancelled" | "already_firing" | "not_cancellable";
}

export class SoulstreamScheduleRepository {
  constructor(private readonly sql: SqlClient) {}

  async createSchedule(params: ScheduleCreateInput): Promise<SoulstreamSchedule> {
    const createdAt = params.createdAt ?? new Date();
    const rows = await this.sql<ScheduleRow[]>`
      INSERT INTO soulstream_schedules (
        schedule_id,
        session_id,
        kind,
        status,
        prompt,
        source_tool,
        tool_use_id,
        cron_expression,
        run_once_at,
        timezone,
        recurring,
        next_run_at,
        created_at,
        updated_at
      ) VALUES (
        ${params.scheduleId},
        ${params.sessionId},
        ${params.kind},
        'active',
        ${params.prompt},
        ${params.sourceTool},
        ${params.toolUseId ?? null},
        ${params.cronExpression ?? null},
        ${params.runOnceAt ?? null},
        ${params.timezone ?? "UTC"},
        ${params.recurring},
        ${params.nextRunAt},
        ${createdAt},
        ${createdAt}
      )
      RETURNING *
    `;
    return scheduleFromRow(requiredRow(rows, "createSchedule"));
  }

  async listSchedules(sessionId: string): Promise<SoulstreamSchedule[]> {
    const rows = await this.sql<ScheduleRow[]>`
      SELECT *
      FROM soulstream_schedules
      WHERE session_id = ${sessionId}
        AND status NOT IN ('completed', 'cancelled')
      ORDER BY next_run_at NULLS LAST, created_at
    `;
    return rows.map(scheduleFromRow);
  }

  async cancelSchedule(
    sessionId: string,
    scheduleId: string,
  ): Promise<CancelScheduleResult> {
    const rows = await this.sql<CancelScheduleRow[]>`
      WITH target AS (
        SELECT *
        FROM soulstream_schedules
        WHERE session_id = ${sessionId}
          AND schedule_id = ${scheduleId}
        FOR UPDATE
      ),
      cancelled AS (
        UPDATE soulstream_schedules schedule
        SET status = 'cancelled',
            claim_token = NULL,
            claimed_until = NULL,
            updated_at = NOW()
        FROM target
        WHERE schedule.schedule_id = target.schedule_id
          AND target.status IN ('active', 'dispatching', 'failed', 'orphaned')
        RETURNING schedule.*
      )
      SELECT 'cancelled'::text AS outcome, cancelled.*
      FROM cancelled
      UNION ALL
      SELECT
        CASE
          WHEN target.status = 'firing' THEN 'already_firing'
          ELSE 'not_cancellable'
        END AS outcome,
        target.*
      FROM target
      WHERE NOT EXISTS (SELECT 1 FROM cancelled)
    `;
    const row = rows[0];
    if (!row) return { outcome: "not_found", schedule: null };
    return { outcome: row.outcome, schedule: scheduleFromRow(row) };
  }

  async touchNodeHeartbeat(nodeId: string, now: Date): Promise<void> {
    await this.sql`
      INSERT INTO soulstream_node_heartbeats (node_id, last_seen_at)
      VALUES (${nodeId}, ${now})
      ON CONFLICT (node_id)
      DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at
    `;
  }

  async repairExpiredClaims(params: {
    now: Date;
    limit: number;
    error: string;
  }): Promise<SoulstreamSchedule[]> {
    const rows = await this.sql<ScheduleRow[]>`
      WITH expired AS (
        SELECT schedule_id
        FROM soulstream_schedules
        WHERE status IN ('dispatching', 'firing')
          AND (claimed_until IS NULL OR claimed_until <= ${params.now})
        ORDER BY claimed_until NULLS FIRST, updated_at
        LIMIT ${params.limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE soulstream_schedules schedule
      SET status = 'active',
          last_error = ${params.error},
          claim_token = NULL,
          claimed_until = NULL,
          updated_at = NOW()
      FROM expired
      WHERE schedule.schedule_id = expired.schedule_id
      RETURNING schedule.*
    `;
    return rows.map(scheduleFromRow);
  }

  async claimDueSchedules(params: {
    nodeId: string;
    now: Date;
    claimToken: string;
    claimedUntil: Date;
    limit: number;
  }): Promise<ClaimedSchedule[]> {
    const rows = await this.sql<ScheduleRow[]>`
      WITH due AS (
        SELECT schedule.schedule_id
        FROM soulstream_schedules schedule
        JOIN sessions session ON session.session_id = schedule.session_id
        WHERE schedule.status = 'active'
          AND schedule.next_run_at <= ${params.now}
          AND session.node_id = ${params.nodeId}
        ORDER BY schedule.next_run_at, schedule.created_at
        LIMIT ${params.limit}
        FOR UPDATE OF schedule SKIP LOCKED
      )
      UPDATE soulstream_schedules schedule
      SET status = 'dispatching',
          claim_token = ${params.claimToken},
          claimed_until = ${params.claimedUntil},
          updated_at = NOW()
      FROM due
      WHERE schedule.schedule_id = due.schedule_id
      RETURNING schedule.*
    `;
    return rows.map((row) => ({
      schedule: scheduleFromRow(row),
      claimToken: params.claimToken,
    }));
  }

  async markOrphanDueSchedules(params: {
    now: Date;
    staleBefore: Date;
    limit: number;
    error: string;
  }): Promise<SoulstreamSchedule[]> {
    const rows = await this.sql<ScheduleRow[]>`
      WITH orphaned AS (
        SELECT schedule.schedule_id
        FROM soulstream_schedules schedule
        LEFT JOIN sessions session ON session.session_id = schedule.session_id
        LEFT JOIN soulstream_node_heartbeats heartbeat
          ON heartbeat.node_id = session.node_id
        WHERE schedule.status = 'active'
          AND schedule.next_run_at <= ${params.now}
          AND (
            session.session_id IS NULL
            OR session.node_id IS NULL
            OR heartbeat.last_seen_at < ${params.staleBefore}
          )
        ORDER BY schedule.next_run_at, schedule.created_at
        LIMIT ${params.limit}
        FOR UPDATE OF schedule SKIP LOCKED
      )
      UPDATE soulstream_schedules schedule
      SET status = 'orphaned',
          last_error = ${params.error},
          claim_token = NULL,
          claimed_until = NULL,
          updated_at = NOW()
      FROM orphaned
      WHERE schedule.schedule_id = orphaned.schedule_id
      RETURNING schedule.*
    `;
    return rows.map(scheduleFromRow);
  }

  async restoreOrphanSchedulesForLiveNodes(params: {
    staleBefore: Date;
    limit: number;
  }): Promise<SoulstreamSchedule[]> {
    const rows = await this.sql<ScheduleRow[]>`
      WITH restorable AS (
        SELECT schedule.schedule_id
        FROM soulstream_schedules schedule
        JOIN sessions session ON session.session_id = schedule.session_id
        JOIN soulstream_node_heartbeats heartbeat
          ON heartbeat.node_id = session.node_id
        WHERE schedule.status = 'orphaned'
          AND heartbeat.last_seen_at >= ${params.staleBefore}
        ORDER BY schedule.updated_at, schedule.created_at
        LIMIT ${params.limit}
        FOR UPDATE OF schedule SKIP LOCKED
      )
      UPDATE soulstream_schedules schedule
      SET status = 'active',
          last_error = NULL,
          updated_at = NOW()
      FROM restorable
      WHERE schedule.schedule_id = restorable.schedule_id
      RETURNING schedule.*
    `;
    return rows.map(scheduleFromRow);
  }

  async consumeClaimedSchedule(
    scheduleId: string,
    claimToken: string,
  ): Promise<SoulstreamSchedule | null> {
    const rows = await this.sql<ScheduleRow[]>`
      UPDATE soulstream_schedules
      SET status = 'firing',
          updated_at = NOW()
      WHERE schedule_id = ${scheduleId}
        AND claim_token = ${claimToken}
        AND status = 'dispatching'
      RETURNING *
    `;
    return rows[0] ? scheduleFromRow(rows[0]) : null;
  }

  async confirmScheduleStillFiring(
    scheduleId: string,
    claimToken: string,
  ): Promise<SoulstreamSchedule | null> {
    const rows = await this.sql<ScheduleRow[]>`
      SELECT *
      FROM soulstream_schedules
      WHERE schedule_id = ${scheduleId}
        AND claim_token = ${claimToken}
        AND status = 'firing'
      LIMIT 1
    `;
    return rows[0] ? scheduleFromRow(rows[0]) : null;
  }

  async deferScheduleDispatch(params: {
    scheduleId: string;
    claimToken: string;
    nextRunAt: Date;
    error: string;
  }): Promise<SoulstreamSchedule | null> {
    const rows = await this.sql<ScheduleRow[]>`
      UPDATE soulstream_schedules
      SET status = 'active',
          next_run_at = ${params.nextRunAt},
          last_error = ${params.error},
          claim_token = NULL,
          claimed_until = NULL,
          updated_at = NOW()
      WHERE schedule_id = ${params.scheduleId}
        AND claim_token = ${params.claimToken}
        AND status = 'firing'
      RETURNING *
    `;
    return rows[0] ? scheduleFromRow(rows[0]) : null;
  }

  async finishScheduleDispatch(params: {
    scheduleId: string;
    claimToken: string;
    recurring: boolean;
    nextRunAt: Date | null;
    firedAt: Date;
  }): Promise<SoulstreamSchedule | null> {
    const rows = await this.sql<ScheduleRow[]>`
      UPDATE soulstream_schedules
      SET status = ${params.recurring ? "active" : "completed"},
          next_run_at = ${params.nextRunAt},
          last_fired_at = ${params.firedAt},
          fired_count = fired_count + 1,
          last_error = NULL,
          claim_token = NULL,
          claimed_until = NULL,
          updated_at = NOW()
      WHERE schedule_id = ${params.scheduleId}
        AND claim_token = ${params.claimToken}
        AND status = 'firing'
      RETURNING *
    `;
    return rows[0] ? scheduleFromRow(rows[0]) : null;
  }

  async failScheduleDispatch(
    scheduleId: string,
    claimToken: string,
    error: string,
  ): Promise<SoulstreamSchedule | null> {
    const rows = await this.sql<ScheduleRow[]>`
      UPDATE soulstream_schedules
      SET status = 'failed',
          last_error = ${error},
          claim_token = NULL,
          claimed_until = NULL,
          updated_at = NOW()
      WHERE schedule_id = ${scheduleId}
        AND claim_token = ${claimToken}
        AND status = 'firing'
      RETURNING *
    `;
    return rows[0] ? scheduleFromRow(rows[0]) : null;
  }
}

function requiredRow<T>(rows: T[], label: string): T {
  const row = rows[0];
  if (!row) throw new Error(`${label} returned no rows`);
  return row;
}

function scheduleFromRow(row: ScheduleRow): SoulstreamSchedule {
  return {
    scheduleId: row.schedule_id,
    sessionId: row.session_id,
    kind: row.kind,
    status: row.status,
    prompt: row.prompt,
    sourceTool: row.source_tool,
    toolUseId: row.tool_use_id,
    cronExpression: row.cron_expression,
    runOnceAt: isoOrNull(row.run_once_at),
    timezone: row.timezone,
    recurring: row.recurring,
    nextRunAt: isoOrNull(row.next_run_at),
    lastFiredAt: isoOrNull(row.last_fired_at),
    firedCount: Number(row.fired_count),
    lastError: row.last_error,
    claimToken: row.claim_token,
    claimedUntil: isoOrNull(row.claimed_until),
    createdAt: isoOrNull(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: isoOrNull(row.updated_at) ?? new Date(0).toISOString(),
  };
}

function isoOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
