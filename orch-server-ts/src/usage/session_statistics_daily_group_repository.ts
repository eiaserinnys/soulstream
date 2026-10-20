import type { BoardYjsQuerySql, BoardYjsSql } from "../board-yjs/board_yjs_sql.js";
import { createSessionStatisticsDailyGroups, dailyFolderPair } from "./session_statistics_daily_groups.js";
import type { DailyBatch } from "./session_statistics_daily_repository.js";
import type { DailySessionState } from "./session_statistics_daily_state.js";
import type { SessionStatisticsReadRequest } from "./session_statistics_types.js";

/** Current folder/card membership invalidates only the affected dates. */
export class SessionStatisticsDailyGroupRepository {
  constructor(private readonly sql: BoardYjsSql) {}

  async staleDays(since: string, before: string, version: number): Promise<string[]> {
    const rows = await this.sql<readonly { day: string }[]>`
      SELECT batch.day::text FROM session_statistics_daily_batches AS batch
      WHERE batch.aggregation_version = ${version} AND batch.ready
        AND batch.day >= ${since}::date AND batch.day < ${before}::date
        AND (
          (EXISTS (SELECT 1 FROM session_statistics_daily_sessions AS cell
            WHERE cell.day = batch.day AND cell.aggregation_version = batch.aggregation_version)
           AND NOT EXISTS (SELECT 1 FROM session_statistics_daily_groups AS g
            WHERE g.day = batch.day AND g.aggregation_version = batch.aggregation_version))
          OR EXISTS (
            SELECT 1 FROM session_statistics_daily_sessions AS cell
            LEFT JOIN sessions AS s ON s.session_id = cell.session_id
            LEFT JOIN cards AS card ON card.id = s.card_id
            WHERE cell.day = batch.day AND cell.aggregation_version = batch.aggregation_version
              AND (s.session_id IS NULL OR cell.folder_id IS DISTINCT FROM s.folder_id
                OR cell.card_folder_id IS DISTINCT FROM card.folder_id)
          )
        )
      ORDER BY batch.day DESC
    `;
    return rows.map(row => row.day);
  }

  async loadOverview(since: string, before: string, version: number,
    input: SessionStatisticsReadRequest, sessionIds: readonly string[]): Promise<DailyBatch[]> {
    const stale = await this.staleDays(since, before, version);
    const rows = await this.sql<readonly {
      day: string; computed_at: string | Date; source_max_event_id: string;
      sessions: DailySessionState[]; groups: NonNullable<DailyBatch["groups"]>;
    }[]>`
      SELECT batch.day::text, batch.computed_at, batch.source_max_event_id::text,
        coalesce(jsonb_agg(cell.payload) FILTER (WHERE cell.kind = 'session'), '[]'::jsonb) AS sessions,
        coalesce(jsonb_agg(cell.payload) FILTER (WHERE cell.kind = 'group'), '[]'::jsonb) AS groups
      FROM session_statistics_daily_batches AS batch
      LEFT JOIN LATERAL (
        SELECT g.payload, 'group' AS kind FROM session_statistics_daily_groups AS g
        WHERE g.day = batch.day AND g.aggregation_version = batch.aggregation_version
          AND NOT (batch.day = ANY(${this.sql.array(stale)}::date[]))
          AND (NOT ${input.access.restricted} OR g.folder_id = ANY(${this.sql.array(input.visibleFolders.map(folder => folder.id))}::text[]))
        UNION ALL
        SELECT s.payload, 'session' AS kind FROM session_statistics_daily_sessions AS s
        WHERE s.day = batch.day AND s.aggregation_version = batch.aggregation_version
          AND batch.day = ANY(${this.sql.array(stale)}::date[])
          AND s.session_id = ANY(${this.sql.array(sessionIds)}::text[])
      ) AS cell ON true
      WHERE batch.aggregation_version = ${version} AND batch.ready
        AND batch.day >= ${since}::date AND batch.day < ${before}::date
      GROUP BY batch.day, batch.computed_at, batch.source_max_event_id
      ORDER BY batch.day
    `;
    const staleSet = new Set(stale);
    return rows.map(row => ({ day: row.day, version, asOf: new Date(row.computed_at).toISOString(),
      sourceMaxEventId: row.source_max_event_id, sessions: row.sessions,
      ...(staleSet.has(row.day) ? {} : { groups: row.groups }),
    }));
  }

  /** Called inside the existing calculator lock, only when no raw date needs work. */
  async regroupNext(since: string, before: string, version: number): Promise<boolean> {
    const [day] = await this.staleDays(since, before, version);
    if (day === undefined) return false;
    await this.sql.begin(async sql => {
      const rows = await sql<readonly { payload: DailySessionState; folder_id: string | null; card_folder_id: string | null }[]>`
        SELECT cell.payload, s.folder_id, card.folder_id AS card_folder_id
        FROM session_statistics_daily_sessions AS cell
        JOIN sessions AS s ON s.session_id = cell.session_id
        LEFT JOIN cards AS card ON card.id = s.card_id
        WHERE cell.day = ${day}::date AND cell.aggregation_version = ${version}
        ORDER BY cell.session_id
      `;
      const sessions = rows.map(row => ({ ...row.payload, folderId: row.folder_id, cardFolderId: row.card_folder_id }));
      await sql`DELETE FROM session_statistics_daily_sessions AS cell
        WHERE cell.day = ${day}::date AND cell.aggregation_version = ${version}
          AND NOT EXISTS (SELECT 1 FROM sessions AS s WHERE s.session_id = cell.session_id)`;
      await sql`UPDATE session_statistics_daily_sessions AS cell
        SET folder_id = current.folder_id, card_folder_id = current.card_folder_id
        FROM jsonb_to_recordset(${sql.json(sessions.map(cell => ({ session_id: cell.sessionId,
          folder_id: cell.folderId, card_folder_id: cell.cardFolderId })))}::jsonb)
          AS current(session_id text, folder_id text, card_folder_id text)
        WHERE cell.day = ${day}::date AND cell.aggregation_version = ${version}
          AND cell.session_id = current.session_id`;
      await saveDailyGroups(sql, day, version, sessions);
    });
    return true;
  }
}

export async function saveDailyGroups(sql: BoardYjsQuerySql, day: string, version: number,
  sessions: readonly DailySessionState[]): Promise<void> {
  await sql`DELETE FROM session_statistics_daily_groups WHERE day = ${day}::date AND aggregation_version = ${version}`;
  const groups = createSessionStatisticsDailyGroups(sessions);
  if (groups.length === 0) return;
  await sql`INSERT INTO session_statistics_daily_groups (day, aggregation_version, group_key, folder_id, card_folder_id, payload)
    SELECT ${day}::date, ${version}, g.group_key, g.folder_id, g.card_folder_id, g.payload
    FROM jsonb_to_recordset(${sql.json(groups.map(group => ({
      group_key: dailyFolderPair(group.folderId, group.cardFolderId),
      folder_id: group.folderId, card_folder_id: group.cardFolderId, payload: group,
    })))}::jsonb) AS g(group_key text, folder_id text, card_folder_id text, payload jsonb)`;
}
