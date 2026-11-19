export interface TurnSummaryCountQuerySql<Query> {
  (strings: TemplateStringsArray, ...values: unknown[]): Query;
}

export interface TurnSummaryCountQueryInput {
  readonly sessionId: string;
  readonly beforeEventId: number | null;
}

export interface TurnSummaryCountRow {
  readonly total_count: number | string;
  readonly digested_count: number | string;
  readonly undigested_count: number | string;
}

export function readTurnSummaryCounts<Query>(
  sql: TurnSummaryCountQuerySql<Query>,
  input: TurnSummaryCountQueryInput,
): Query {
  return sql`
    WITH input AS (
      SELECT ${input.sessionId}::text AS session_id
    ),
    watermark AS (
      SELECT COALESCE(d.narrative_through_event_id, 0) AS event_id
      FROM input
      LEFT JOIN session_digests d ON d.session_id = input.session_id
    )
    SELECT
      COUNT(*)::integer AS total_count,
      COUNT(*) FILTER (
        WHERE e.id <= (SELECT event_id FROM watermark)
      )::integer AS digested_count,
      COUNT(*) FILTER (
        WHERE e.id > (SELECT event_id FROM watermark)
      )::integer AS undigested_count
    FROM events e
    JOIN input ON input.session_id = e.session_id
    WHERE e.event_type = 'turn_summary'
      AND (${input.beforeEventId}::bigint IS NULL OR e.id < ${input.beforeEventId})
  `;
}
