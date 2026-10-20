import type { BoardYjsSql } from "../board-yjs/board_yjs_sql.js";
import type { SessionStatisticsDailyState } from "./session_statistics_daily_state.js";

export type DailyBatch = SessionStatisticsDailyState & { sourceMaxEventId: string };
export interface SessionStatisticsDailyRepositoryPort {
  load(since: string, before: string, version: number, sessionIds?: readonly string[]): Promise<DailyBatch[]>;
  sourceMax(since: string, before: string): Promise<ReadonlyMap<string, string>>;
  save(state: SessionStatisticsDailyState, sourceMaxEventId: string): Promise<void>;
  withLock(work: () => Promise<void>): Promise<boolean>;
}

export class SessionStatisticsDailyRepository implements SessionStatisticsDailyRepositoryPort {
  constructor(private readonly sql: BoardYjsSql) {}

  async load(since: string, before: string, version: number, sessionIds?: readonly string[]): Promise<DailyBatch[]> {
    const rows = await this.sql<readonly {
      day: string; computed_at: string | Date; source_max_event_id: string; sessions: unknown;
    }[]>`
      SELECT batch.day::text, batch.computed_at, batch.source_max_event_id::text,
        coalesce(jsonb_agg(cell.payload ORDER BY cell.session_id)
          FILTER (WHERE cell.session_id IS NOT NULL), '[]'::jsonb) AS sessions
      FROM session_statistics_daily_batches AS batch
      LEFT JOIN session_statistics_daily_sessions AS cell
        ON cell.day = batch.day AND cell.aggregation_version = batch.aggregation_version
        AND (${sessionIds === undefined} OR cell.session_id = ANY(${this.sql.array(sessionIds ?? [])}::text[]))
      WHERE batch.aggregation_version = ${version} AND batch.ready
        AND batch.day >= ${since}::date AND batch.day < ${before}::date
      GROUP BY batch.day, batch.computed_at, batch.source_max_event_id
      ORDER BY batch.day
    `;
    return rows.map(row => ({ day: row.day, version,
      asOf: new Date(row.computed_at).toISOString(), sourceMaxEventId: row.source_max_event_id,
      sessions: (typeof row.sessions === "string" ? JSON.parse(row.sessions) : row.sessions) as DailyBatch["sessions"],
    }));
  }

  async sourceMax(since: string, before: string): Promise<ReadonlyMap<string, string>> {
    const rows = await this.sql<readonly { day: string; max_event_id: string }[]>`
      SELECT (recorded_at AT TIME ZONE 'Asia/Seoul')::date::text AS day,
        max(event_id)::text AS max_event_id
      FROM session_statistics_facts
      WHERE recorded_at >= (${since}::date::timestamp AT TIME ZONE 'Asia/Seoul')
        AND recorded_at < (${before}::date::timestamp AT TIME ZONE 'Asia/Seoul')
      GROUP BY (recorded_at AT TIME ZONE 'Asia/Seoul')::date
    `;
    return new Map(rows.map(row => [row.day, row.max_event_id]));
  }

  async save(state: SessionStatisticsDailyState, sourceMaxEventId: string): Promise<void> {
    await this.sql.begin(async sql => {
      await sql`INSERT INTO session_statistics_daily_batches
        (day, aggregation_version, computed_at, source_max_event_id, ready)
        VALUES (${state.day}::date, ${state.version}, ${state.asOf}::timestamptz, ${sourceMaxEventId}::bigint, false)
        ON CONFLICT (day, aggregation_version) DO UPDATE SET ready = false`;
      await sql`DELETE FROM session_statistics_daily_sessions
        WHERE day = ${state.day}::date AND aggregation_version = ${state.version}`;
      if (state.sessions.length > 0) {
        await sql`INSERT INTO session_statistics_daily_sessions (day, aggregation_version, session_id, payload)
          SELECT ${state.day}::date, ${state.version}, cell.session_id, cell.payload
          FROM jsonb_to_recordset(${sql.json(state.sessions.map(cell => ({ session_id: cell.sessionId, payload: cell })))}::jsonb)
            AS cell(session_id text, payload jsonb)`;
      }
      await sql`UPDATE session_statistics_daily_batches SET computed_at = ${state.asOf}::timestamptz,
        source_max_event_id = ${sourceMaxEventId}::bigint, ready = true
        WHERE day = ${state.day}::date AND aggregation_version = ${state.version}`;
    });
  }

  async withLock(work: () => Promise<void>): Promise<boolean> {
    return this.sql.begin(async sql => {
      const [row] = await sql<readonly { acquired: boolean }[]>`SELECT pg_try_advisory_xact_lock(485, 1) AS acquired`;
      if (row?.acquired !== true) return false;
      await work();
      return true;
    });
  }
}
