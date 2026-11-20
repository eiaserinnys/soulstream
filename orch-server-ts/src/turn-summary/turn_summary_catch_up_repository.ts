import type { LiveDbSqlResolver } from "../runtime/live_db_sql.js";

export interface TurnSummaryCatchUpCandidate {
  readonly nodeId: string;
  readonly sessionId: string;
  readonly completeEventId: number;
}

export interface TurnSummaryCatchUpCandidateQuery {
  readonly since: Date;
  readonly olderThan: Date;
  readonly excludedFolderIds: readonly string[];
  readonly limit: number;
}

export interface TurnSummaryCatchUpRepositoryPort {
  listCatchUpCandidates(
    input: TurnSummaryCatchUpCandidateQuery,
  ): Promise<TurnSummaryCatchUpCandidate[]>;
}

export class TurnSummaryCatchUpRepository
implements TurnSummaryCatchUpRepositoryPort {
  constructor(private readonly sqlResolver: Pick<LiveDbSqlResolver, "resolveSql">) {}

  async listCatchUpCandidates(
    input: TurnSummaryCatchUpCandidateQuery,
  ): Promise<TurnSummaryCatchUpCandidate[]> {
    const sql = await this.sqlResolver.resolveSql();
    const rows = await sql`
      SELECT c.session_id, c.id, s.node_id
      FROM events c
      JOIN sessions s ON s.session_id = c.session_id
      WHERE c.event_type = 'complete'
        AND c.created_at >= ${input.since}
        AND c.created_at < ${input.olderThan}
        AND (
          s.folder_id IS NULL
          OR s.folder_id <> ALL(${input.excludedFolderIds}::text[])
        )
        AND NOT EXISTS (
          SELECT 1
          FROM events t
          WHERE t.session_id = c.session_id
            AND t.event_type = 'turn_summary'
            AND t.parent_event_id < c.id
            AND t.parent_event_id > COALESCE((
              SELECT max(p.id)
              FROM events p
              WHERE p.session_id = c.session_id
                AND p.event_type = 'complete'
                AND p.id < c.id
            ), 0)
        )
      ORDER BY c.created_at ASC, c.id ASC
      LIMIT ${input.limit}
    `;
    const candidates: TurnSummaryCatchUpCandidate[] = [];
    for (const row of rows) {
      const sessionId = nonEmptyString(row.session_id);
      const nodeId = nonEmptyString(row.node_id);
      const completeEventId = positiveInteger(row.id);
      if (sessionId === null || nodeId === null || completeEventId === null) {
        continue;
      }
      candidates.push({ sessionId, nodeId, completeEventId });
    }
    return candidates;
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function positiveInteger(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}
