import type { SqlClient } from "../control_plane_types.js";

export interface HostSessionStoryTurnSummary {
  readonly eventId: number;
  readonly turnNumber: number;
  readonly content: string;
  readonly turnStartEventId: number | null;
  readonly finalResponseEventId: number | null;
  readonly createdAt: Date;
}

export interface HostSessionStoryView {
  readonly highlight: string | null;
  readonly narrative: string | null;
  readonly unfoldedTurnSummaries: HostSessionStoryTurnSummary[];
  readonly narrativeThroughEventId: number | null;
  readonly foldCount: number;
  readonly updatedAt: Date | null;
}

export interface HostSessionTurnSummaryCounts {
  readonly totalCount: number;
  readonly digestedCount: number;
  readonly undigestedCount: number;
}

export interface HostSessionSearchMetadata {
  readonly turnCount: number;
  readonly hasTurnSummaries: boolean;
  readonly hasStoryDigest: boolean;
  readonly hasHighlight: boolean;
}

export class SessionStoryReadRepository {
  constructor(private readonly sql: SqlClient) {}

  async getSessionSearchMetadata(
    sessionIds: string[],
  ): Promise<Array<[string, HostSessionSearchMetadata]>> {
    if (sessionIds.length === 0) return [];
    const rows = await this.sql<Array<{
      session_id: string;
      turn_count: number | string;
      has_turn_summaries: boolean;
      has_story_digest: boolean;
      has_highlight: boolean;
    }>>`
      WITH requested AS (
        SELECT UNNEST(${sessionIds}::text[]) AS session_id
      )
      SELECT
        requested.session_id,
        COUNT(e.id) FILTER (
          WHERE e.event_type IN (
            'user_message',
            'intervention_sent',
            'session_notification'
          )
        )::integer AS turn_count,
        COALESCE(BOOL_OR(e.event_type = 'turn_summary'), false)
          AS has_turn_summaries,
        (d.session_id IS NOT NULL) AS has_story_digest,
        COALESCE(NULLIF(BTRIM(d.highlight), '') IS NOT NULL, false)
          AS has_highlight
      FROM requested
      LEFT JOIN events e ON e.session_id = requested.session_id
      LEFT JOIN session_digests d ON d.session_id = requested.session_id
      GROUP BY requested.session_id, d.session_id, d.highlight
    `;
    return rows.map((row) => [row.session_id, {
      turnCount: Number(row.turn_count),
      hasTurnSummaries: row.has_turn_summaries,
      hasStoryDigest: row.has_story_digest,
      hasHighlight: row.has_highlight,
    }]);
  }

  async countTurnSummaries(sessionId: string): Promise<HostSessionTurnSummaryCounts> {
    const rows = await this.sql<Array<{
      total_count: number | string;
      digested_count: number | string;
      undigested_count: number | string;
    }>>`
      WITH input AS (
        SELECT ${sessionId}::text AS session_id
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
    `;
    return {
      totalCount: Number(rows[0]?.total_count ?? 0),
      digestedCount: Number(rows[0]?.digested_count ?? 0),
      undigestedCount: Number(rows[0]?.undigested_count ?? 0),
    };
  }

  async loadTurnSummaryRange(
    sessionId: string,
    fromTurnNumber: number,
    toTurnNumber: number | null,
    limit: number,
  ): Promise<HostSessionStoryTurnSummary[]> {
    const rows = toTurnNumber === null
      ? await this.sql<SummaryRow[]>`
          WITH ordered_summaries AS (
            SELECT id, payload, created_at,
              ROW_NUMBER() OVER (ORDER BY id ASC)::integer AS turn_number
            FROM events
            WHERE session_id = ${sessionId} AND event_type = 'turn_summary'
          )
          SELECT id, payload, created_at, turn_number
          FROM ordered_summaries
          WHERE turn_number >= ${fromTurnNumber}
          ORDER BY turn_number ASC
          LIMIT ${limit}
        `
      : await this.sql<SummaryRow[]>`
          WITH ordered_summaries AS (
            SELECT id, payload, created_at,
              ROW_NUMBER() OVER (ORDER BY id ASC)::integer AS turn_number
            FROM events
            WHERE session_id = ${sessionId} AND event_type = 'turn_summary'
          )
          SELECT id, payload, created_at, turn_number
          FROM ordered_summaries
          WHERE turn_number >= ${fromTurnNumber}
            AND turn_number <= ${toTurnNumber}
          ORDER BY turn_number ASC
          LIMIT ${limit}
        `;
    return summaries(rows);
  }

  async searchSessionDigests(
    query: string,
    sessionIds: string[] | null,
    limit: number,
    includeHighlight: boolean,
    includeStory: boolean,
  ): Promise<Array<Record<string, unknown>>> {
    if (!includeHighlight && !includeStory) return [];
    const rows = sessionIds === null
      ? await this.searchAll(query, limit, includeHighlight, includeStory)
      : await this.searchSelected(query, sessionIds, limit, includeHighlight, includeStory);
    return rows.map(normalizeDigestSearchMatch);
  }

  async getSessionStory(sessionId: string): Promise<HostSessionStoryView> {
    const digestRows = await this.sql<Array<{
      highlight: string;
      narrative: string;
      narrative_through_event_id: number;
      fold_count: number;
      updated_at: Date;
    }>>`
      SELECT highlight, narrative, narrative_through_event_id, fold_count, updated_at
      FROM session_digests
      WHERE session_id = ${sessionId}
      LIMIT 1
    `;
    const digest = digestRows[0];
    const summaryRows = await this.sql<SummaryRow[]>`
      WITH ordered_summaries AS (
        SELECT id, payload, created_at,
          ROW_NUMBER() OVER (ORDER BY id ASC)::integer AS turn_number
        FROM events
        WHERE session_id = ${sessionId} AND event_type = 'turn_summary'
      )
      SELECT id, payload, created_at, turn_number
      FROM ordered_summaries
      WHERE id > ${digest?.narrative_through_event_id ?? 0}
      ORDER BY id ASC
    `;
    return {
      highlight: digest?.highlight ?? null,
      narrative: digest?.narrative ?? null,
      unfoldedTurnSummaries: summaries(summaryRows),
      narrativeThroughEventId:
        digest === undefined ? null : Number(digest.narrative_through_event_id),
      foldCount: Number(digest?.fold_count ?? 0),
      updatedAt: digest?.updated_at ?? null,
    };
  }

  private searchAll(query: string, limit: number, includeHighlight: boolean, includeStory: boolean): Promise<DigestSearchRow[]> {
    return this.sql<DigestSearchRow[]>`
      SELECT d.narrative_through_event_id AS id, d.session_id,
        matches.event_type, matches.searchable_text,
        1.0 / matches.position AS score, matches.match_source
      FROM session_digests d
      CROSS JOIN LATERAL (
        SELECT 'session_highlight'::text AS event_type, d.highlight AS searchable_text,
          STRPOS(LOWER(d.highlight), LOWER(${query})) AS position,
          'highlight'::text AS match_source
        WHERE ${includeHighlight}
        UNION ALL
        SELECT 'session_story'::text, d.narrative,
          STRPOS(LOWER(d.narrative), LOWER(${query})), 'story'::text
        WHERE ${includeStory}
      ) matches
      WHERE matches.position > 0
      ORDER BY score DESC, d.updated_at DESC, d.session_id ASC
      LIMIT ${limit}
    `;
  }

  private searchSelected(query: string, sessionIds: string[], limit: number, includeHighlight: boolean, includeStory: boolean): Promise<DigestSearchRow[]> {
    return this.sql<DigestSearchRow[]>`
      SELECT d.narrative_through_event_id AS id, d.session_id,
        matches.event_type, matches.searchable_text,
        1.0 / matches.position AS score, matches.match_source
      FROM session_digests d
      CROSS JOIN LATERAL (
        SELECT 'session_highlight'::text AS event_type, d.highlight AS searchable_text,
          STRPOS(LOWER(d.highlight), LOWER(${query})) AS position,
          'highlight'::text AS match_source
        WHERE ${includeHighlight}
        UNION ALL
        SELECT 'session_story'::text, d.narrative,
          STRPOS(LOWER(d.narrative), LOWER(${query})), 'story'::text
        WHERE ${includeStory}
      ) matches
      WHERE d.session_id = ANY(${sessionIds}::text[])
        AND matches.position > 0
      ORDER BY score DESC, d.updated_at DESC, d.session_id ASC
      LIMIT ${limit}
    `;
  }
}

type SummaryRow = { id: number; payload: unknown; created_at: Date; turn_number: number };
type DigestSearchRow = {
  id: number | string;
  session_id: string;
  event_type: string;
  searchable_text: string;
  score: number | string;
  match_source: string;
};

function summaries(rows: SummaryRow[]): HostSessionStoryTurnSummary[] {
  return rows.map(normalizeSummary).filter((value): value is HostSessionStoryTurnSummary => value !== null);
}

function normalizeSummary(row: SummaryRow): HostSessionStoryTurnSummary | null {
  const payload = parsePayload(row.payload);
  const content = typeof payload.content === "string" ? payload.content.trim() : "";
  if (content.length === 0) return null;
  return {
    eventId: Number(row.id),
    turnNumber: Number(row.turn_number),
    content,
    turnStartEventId: positiveIntegerOrNull(payload.turn_start_event_id),
    finalResponseEventId: positiveIntegerOrNull(payload.final_response_event_id),
    createdAt: row.created_at,
  };
}

function normalizeDigestSearchMatch(row: DigestSearchRow): Record<string, unknown> {
  if (row.event_type !== "session_highlight" && row.event_type !== "session_story") {
    throw new Error(`invalid digest search event type: ${row.event_type}`);
  }
  if (row.match_source !== "highlight" && row.match_source !== "story") {
    throw new Error(`invalid digest search source: ${row.match_source}`);
  }
  return {
    id: Number(row.id),
    session_id: row.session_id,
    event_type: row.event_type,
    searchable_text: row.searchable_text,
    score: Number(row.score),
    match_source: row.match_source,
  };
}

function parsePayload(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function positiveIntegerOrNull(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}
