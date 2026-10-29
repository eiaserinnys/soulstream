import type { SqlClient } from "../control_plane_types.js";
import { withLiveSearchDbConnection } from "../../runtime/live_db_sql.js";
import type {
  LiveSearchDbConnectionFactory,
  LiveSearchPendingQuery,
  LiveSearchQueryRunner,
  LiveSearchSql,
} from "../../runtime/live_db_sql.js";
import type { SessionReadPeriod } from "@soulstream/mcp-contract";

export interface HostSessionStoryTurnSummary {
  readonly eventId: number;
  readonly turnNumber: number;
  readonly content: string;
  readonly turnStartEventId: number | null;
  readonly finalResponseEventId: number | null;
  readonly createdAt: Date;
}

export interface HostSessionTurnTranscriptEvent {
  readonly eventId: number;
  readonly eventType: string;
  readonly text: string;
  readonly createdAt: Date;
}

export interface HostSessionTurnTranscript {
  readonly turnNumber: number;
  readonly events: HostSessionTurnTranscriptEvent[];
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
  readonly cardId: string | null;
  readonly cardNumber: number | null;
  readonly cardTitle: string | null;
  readonly cardStatus: string | null;
}

export class SessionStoryReadRepository {
  constructor(
    private readonly sql: SqlClient,
    private readonly searchConnectionFactory?: LiveSearchDbConnectionFactory,
    private readonly onSearchCancelError?: (error: unknown) => void,
  ) {}

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
      card_id: string | null;
      card_number: number | string | null;
      card_title: string | null;
      card_status: string | null;
    }>>`
      WITH requested AS (
        SELECT DISTINCT requested_session.session_id
        FROM UNNEST(${sessionIds}::text[]) AS requested_session(session_id)
      ),
      event_metadata AS (
        SELECT
          requested.session_id,
          (
            SELECT COUNT(*)
            FROM events e
            WHERE e.session_id = requested.session_id
              AND e.event_type IN (
                'user_message',
                'intervention_sent',
                'session_notification'
              )
          )::integer AS turn_count,
          EXISTS (
            SELECT 1
            FROM events e
            WHERE e.session_id = requested.session_id
              AND e.event_type = 'turn_summary'
          ) AS has_turn_summaries
        FROM requested
      )
      SELECT
        requested.session_id,
        event_metadata.turn_count,
        event_metadata.has_turn_summaries,
        (d.session_id IS NOT NULL) AS has_story_digest,
        COALESCE(NULLIF(BTRIM(d.highlight), '') IS NOT NULL, false) AS has_highlight,
        linked_card.id AS card_id,
        linked_card.number AS card_number,
        linked_card.title AS card_title,
        linked_card.status AS card_status
      FROM requested
      LEFT JOIN sessions session ON session.session_id = requested.session_id
      LEFT JOIN event_metadata ON event_metadata.session_id = requested.session_id
      LEFT JOIN session_digests d ON d.session_id = requested.session_id
      LEFT JOIN LATERAL (
        SELECT card.id, card.number, card.title, card.status
        FROM cards card
        WHERE card.id = session.card_id
          OR (card.assignee_session_id = session.session_id AND card.archived = FALSE)
          OR (card.completed_session_id = session.session_id AND card.archived = FALSE)
        ORDER BY
          CASE
            WHEN card.id = session.card_id THEN 0
            WHEN card.assignee_session_id = session.session_id THEN 1
            ELSE 2
          END,
          card.updated_at DESC,
          card.id ASC
        LIMIT 1
      ) linked_card ON TRUE
    `;
    return rows.map((row) => [row.session_id, {
      turnCount: Number(row.turn_count),
      hasTurnSummaries: row.has_turn_summaries,
      hasStoryDigest: row.has_story_digest,
      hasHighlight: row.has_highlight,
      cardId: row.card_id ?? null,
      cardNumber: row.card_number === null ? null : Number(row.card_number),
      cardTitle: row.card_title ?? null,
      cardStatus: row.card_status ?? null,
    }]);
  }

  async countTurnSummaries(
    sessionId: string,
    options: { readonly beforeEventId?: number; readonly signal?: AbortSignal; readonly deadlineAt?: number } = {},
  ): Promise<HostSessionTurnSummaryCounts> {
    const run = (sql: LiveSearchSql) => sql<Array<{
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
        AND (${options.beforeEventId ?? null}::bigint IS NULL OR e.id < ${options.beforeEventId ?? null})
      `;
    const rows = options.signal === undefined && options.deadlineAt === undefined
      ? await run(this.sql as unknown as LiveSearchSql)
      : await this.runOwnedSearch(options.signal, options.deadlineAt, (query) => query((sql) => run(sql)));
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
    options: { readonly beforeEventId?: number; readonly signal?: AbortSignal; readonly deadlineAt?: number; readonly period?: SessionReadPeriod } = {},
  ): Promise<HostSessionStoryTurnSummary[]> {
    const run = (query: LiveSearchSql) => {
      if (options.period) {
        return query<SummaryRow[]>`
          WITH ordered_summaries AS (
            SELECT session_id, id, payload, created_at,
              ROW_NUMBER() OVER (ORDER BY id ASC)::integer AS turn_number
            FROM events
            WHERE session_id = ${sessionId} AND event_type = 'turn_summary'
          )
          SELECT id, payload, created_at, turn_number
          FROM ordered_summaries
          WHERE turn_number >= ${fromTurnNumber}
            AND (${toTurnNumber}::integer IS NULL OR turn_number <= ${toTurnNumber})
            AND (${options.beforeEventId ?? null}::bigint IS NULL OR id < ${options.beforeEventId ?? null})
            AND (
              (created_at >= ${options.period.since}::timestamptz
                AND created_at < ${options.period.until}::timestamptz)
              OR EXISTS (
                SELECT 1 FROM events final_response
                WHERE final_response.session_id = ordered_summaries.session_id
                  AND final_response.id::text = ordered_summaries.payload->>'final_response_event_id'
                  AND final_response.created_at >= ${options.period.since}::timestamptz
                  AND final_response.created_at < ${options.period.until}::timestamptz
              )
            )
          ORDER BY turn_number ASC
          LIMIT ${limit}
        `;
      }
      return toTurnNumber === null
      ? query<SummaryRow[]>`
          WITH ordered_summaries AS (
            SELECT id, payload, created_at,
              ROW_NUMBER() OVER (ORDER BY id ASC)::integer AS turn_number
            FROM events
            WHERE session_id = ${sessionId} AND event_type = 'turn_summary'
          )
          SELECT id, payload, created_at, turn_number
          FROM ordered_summaries
          WHERE turn_number >= ${fromTurnNumber}
            AND (${options.beforeEventId ?? null}::bigint IS NULL OR id < ${options.beforeEventId ?? null})
          ORDER BY turn_number ASC
          LIMIT ${limit}
        `
      : query<SummaryRow[]>`
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
            AND (${options.beforeEventId ?? null}::bigint IS NULL OR id < ${options.beforeEventId ?? null})
          ORDER BY turn_number ASC
          LIMIT ${limit}
        `;
    };
    const rows = options.signal === undefined && options.deadlineAt === undefined
      ? await run(this.sql as unknown as LiveSearchSql)
      : await this.runOwnedSearch(options.signal, options.deadlineAt, (query) => query((sql) => run(sql)));
    return summaries(rows);
  }

  async loadTurnTranscript(
    sessionId: string,
    selectedSummaries: readonly HostSessionStoryTurnSummary[],
    includeTools: boolean,
  ): Promise<HostSessionTurnTranscript[]> {
    if (selectedSummaries.length === 0) return [];
    const eventTypes = includeTools
      ? ["user_message", "intervention_sent", "session_notification", "assistant_message", "tool_start", "tool_result"]
      : ["user_message", "intervention_sent", "session_notification", "assistant_message"];
    const rows = await this.sql<TranscriptEventRow[]>`
      WITH selected_summaries AS (
        SELECT selected.turn_number, selected.summary_event_id,
          selected.final_response_event_id
        FROM UNNEST(
          ${selectedSummaries.map((summary) => summary.turnNumber)}::integer[],
          ${selectedSummaries.map((summary) => summary.eventId)}::bigint[],
          ${selectedSummaries.map((summary) => summary.finalResponseEventId)}::bigint[]
        ) AS selected(turn_number, summary_event_id, final_response_event_id)
      ), current_turn_completes AS (
        SELECT selected.turn_number,
          (
            SELECT MIN(current_complete.id)
            FROM events current_complete
            WHERE current_complete.session_id = ${sessionId}
              AND current_complete.event_type = 'complete'
              AND current_complete.id > selected.final_response_event_id
              AND current_complete.id < selected.summary_event_id
          ) AS complete_event_id
        FROM selected_summaries selected
      ), turn_ranges AS (
        SELECT current_turn.turn_number,
          current_turn.complete_event_id,
          (
            SELECT MAX(previous_complete.id)
            FROM events previous_complete
            WHERE previous_complete.session_id = ${sessionId}
              AND previous_complete.event_type = 'complete'
              AND previous_complete.id < current_turn.complete_event_id
          ) AS previous_complete_event_id
        FROM current_turn_completes current_turn
      )
      SELECT turn_ranges.turn_number,
        source_event.id,
        source_event.event_type,
        source_event.payload,
        COALESCE(source_event.searchable_text, '') AS text,
        source_event.created_at
      FROM turn_ranges
      JOIN events source_event
        ON source_event.session_id = ${sessionId}
        AND source_event.id > COALESCE(turn_ranges.previous_complete_event_id, 0)
        AND source_event.id <= turn_ranges.complete_event_id
      WHERE source_event.event_type = ANY(${eventTypes}::text[])
      ORDER BY turn_ranges.turn_number ASC, source_event.id ASC
    `;
    const eventsByTurn = new Map<number, HostSessionTurnTranscriptEvent[]>(
      selectedSummaries.map((summary) => [summary.turnNumber, []]),
    );
    for (const row of rows) {
      eventsByTurn.get(Number(row.turn_number))?.push({
        eventId: Number(row.id),
        eventType: row.event_type,
        text: transcriptEventText(row.event_type, parsePayload(row.payload), row.text),
        createdAt: row.created_at,
      });
    }
    return selectedSummaries.map((summary) => ({
      turnNumber: summary.turnNumber,
      events: eventsByTurn.get(summary.turnNumber) ?? [],
    }));
  }

  async searchSessionDigests(
    query: string,
    sessionIds: string[] | null,
    limit: number,
    includeHighlight: boolean,
    includeStory: boolean,
    signal?: AbortSignal,
  ): Promise<Array<Record<string, unknown>>> {
    if (!includeHighlight && !includeStory) return [];
    const createQuery = (sql: LiveSearchSql) => sessionIds === null
      ? this.searchAll(sql, query, limit, includeHighlight, includeStory)
      : this.searchSelected(sql, query, sessionIds, limit, includeHighlight, includeStory);
    let rows: readonly DigestSearchRow[];
    if (signal === undefined) {
      rows = await createQuery(this.sql as unknown as LiveSearchSql);
    } else {
      if (!this.searchConnectionFactory) {
        throw new Error("digest search cancellation requires a request-owned search connection");
      }
      rows = await this.runOwnedSearch(signal, undefined, (runQuery) => runQuery(createQuery));
    }
    return rows.map(normalizeDigestSearchMatch);
  }

  async searchSessionDigestsOnConnection(
    query: string,
    sessionIds: string[] | null,
    limit: number,
    includeHighlight: boolean,
    includeStory: boolean,
    runQuery: LiveSearchQueryRunner,
  ): Promise<Array<Record<string, unknown>>> {
    if (!includeHighlight && !includeStory) return [];
    const createQuery = (sql: LiveSearchSql) => sessionIds === null
      ? this.searchAll(sql, query, limit, includeHighlight, includeStory)
      : this.searchSelected(sql, query, sessionIds, limit, includeHighlight, includeStory);
    const rows = await runQuery(createQuery);
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
    const watermark = digest?.narrative_through_event_id ?? 0;
    const summaryRows = await this.sql<SummaryRow[]>`
      WITH folded AS (
        SELECT COUNT(*)::integer AS folded_count
        FROM events
        WHERE session_id = ${sessionId}
          AND event_type = 'turn_summary'
          AND id <= ${watermark}
      )
      SELECT e.id, e.payload, e.created_at,
        ((SELECT folded_count FROM folded) + ROW_NUMBER() OVER (ORDER BY e.id ASC))::integer AS turn_number
      FROM events e
      WHERE e.session_id = ${sessionId}
        AND e.event_type = 'turn_summary'
        AND e.id > ${watermark}
      ORDER BY e.id ASC
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

  private searchAll(sql: LiveSearchSql, query: string, limit: number, includeHighlight: boolean, includeStory: boolean): LiveSearchPendingQuery<readonly DigestSearchRow[]> {
    return sql<readonly DigestSearchRow[]>`
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

  private searchSelected(sql: LiveSearchSql, query: string, sessionIds: string[], limit: number, includeHighlight: boolean, includeStory: boolean): LiveSearchPendingQuery<readonly DigestSearchRow[]> {
    return sql<readonly DigestSearchRow[]>`
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

  private async runOwnedSearch<T extends readonly Record<string, unknown>[]>(
    signal: AbortSignal | undefined,
    deadlineAt: number | undefined,
    runQuery: (query: LiveSearchQueryRunner) => Promise<T>,
  ): Promise<T> {
    if (!this.searchConnectionFactory) {
      throw new Error("digest search cancellation requires a request-owned search connection");
    }
    try {
      return await withLiveSearchDbConnection(
        this.searchConnectionFactory,
        signal,
        (error) => this.reportSearchCancelError(error),
        runQuery,
        deadlineAt,
      );
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason ?? new Error("digest search was cancelled");
      }
      if (isPostgresStatementTimeout(error)) throw new SessionDigestSearchDeadlineError();
      throw error;
    }
  }

  private reportSearchCancelError(error: unknown): void {
    try {
      this.onSearchCancelError?.(error);
    } catch {
      // Cancellation reporting must not hide the caller's cancellation error.
    }
  }
}

export class SessionDigestSearchDeadlineError extends Error {
  readonly statusCode = 504;

  constructor() {
    super("session digest search exceeded its database time limit");
    this.name = "SessionDigestSearchDeadlineError";
  }
}

function isPostgresStatementTimeout(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "57014";
}

type SummaryRow = { id: number; payload: unknown; created_at: Date; turn_number: number };
type TranscriptEventRow = {
  turn_number: number | string;
  id: number | string;
  event_type: string;
  payload: unknown;
  text: string;
  created_at: Date;
};
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

function transcriptEventText(
  eventType: string,
  payload: Record<string, unknown>,
  searchableText: string,
): string {
  if (
    eventType === "user_message" ||
    eventType === "intervention_sent" ||
    eventType === "session_notification"
  ) {
    return typeof payload.text === "string" ? payload.text : searchableText;
  }
  if (eventType === "assistant_message") {
    return typeof payload.content === "string" ? payload.content : searchableText;
  }
  if (eventType === "tool_start") {
    const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "unknown_tool";
    const input = transcriptValueText(payload.tool_input);
    return input ? `tool: ${toolName} input: ${input}` : `tool: ${toolName}`;
  }
  if (eventType === "tool_result") {
    const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "unknown_tool";
    const result = transcriptValueText(payload.result);
    return result ? `tool: ${toolName} result: ${result}` : `tool: ${toolName} result:`;
  }
  return searchableText;
}

function transcriptValueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => item && typeof item === "object" && "text" in item && typeof item.text === "string"
        ? item.text
        : "")
      .filter(Boolean)
      .join(" ");
  }
  if (value === null || value === undefined) return "";
  return JSON.stringify(value) ?? "";
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
