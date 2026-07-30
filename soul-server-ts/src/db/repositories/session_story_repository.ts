import type { SqlClient } from "../session_db_types.js";
import { isRecord } from "./repository_helpers.js";

export interface SessionStoryTurnSummary {
  readonly eventId: number;
  readonly turnNumber: number;
  readonly content: string;
  readonly turnStartEventId: number | null;
  readonly finalResponseEventId: number | null;
  readonly createdAt: Date;
}

export interface SessionStoryView {
  readonly highlight: string | null;
  readonly narrative: string | null;
  readonly unfoldedTurnSummaries: SessionStoryTurnSummary[];
  readonly narrativeThroughEventId: number | null;
  readonly foldCount: number;
  readonly updatedAt: Date | null;
}

export class SessionStoryReadRepository {
  constructor(private readonly sql: SqlClient) {}

  async getSessionStory(sessionId: string): Promise<SessionStoryView> {
    const digestRows = await this.sql<{
      highlight: string;
      narrative: string;
      narrative_through_event_id: number;
      fold_count: number;
      updated_at: Date;
    }[]>`
      SELECT
        highlight,
        narrative,
        narrative_through_event_id,
        fold_count,
        updated_at
      FROM session_digests
      WHERE session_id = ${sessionId}
      LIMIT 1
    `;
    const digest = digestRows[0];
    const watermark = digest?.narrative_through_event_id ?? 0;
    const summaryRows = await this.sql<{
      id: number;
      payload: unknown;
      created_at: Date;
      turn_number: number;
    }[]>`
      WITH ordered_summaries AS (
        SELECT
          id,
          payload,
          created_at,
          ROW_NUMBER() OVER (ORDER BY id ASC)::integer AS turn_number
        FROM events
        WHERE session_id = ${sessionId}
          AND event_type = 'turn_summary'
      )
      SELECT id, payload, created_at, turn_number
      FROM ordered_summaries
      WHERE id > ${watermark}
      ORDER BY id ASC
    `;
    const unfoldedTurnSummaries = summaryRows
      .map(normalizeSummary)
      .filter((summary): summary is SessionStoryTurnSummary => summary !== null);
    if (digest === undefined) {
      return {
        highlight: null,
        narrative: null,
        unfoldedTurnSummaries,
        narrativeThroughEventId: null,
        foldCount: 0,
        updatedAt: null,
      };
    }
    return {
      highlight: digest.highlight,
      narrative: digest.narrative,
      unfoldedTurnSummaries,
      narrativeThroughEventId: Number(digest.narrative_through_event_id),
      foldCount: Number(digest.fold_count),
      updatedAt: toDate(digest.updated_at),
    };
  }
}

function normalizeSummary(row: {
  id: number;
  payload: unknown;
  created_at: Date;
  turn_number: number;
}): SessionStoryTurnSummary | null {
  const payload = parsePayload(row.payload);
  const content = typeof payload.content === "string"
    ? payload.content.trim()
    : "";
  if (content.length === 0) return null;
  return {
    eventId: Number(row.id),
    turnNumber: Number(row.turn_number),
    content,
    turnStartEventId: integerOrNull(payload.turn_start_event_id),
    finalResponseEventId: integerOrNull(payload.final_response_event_id),
    createdAt: toDate(row.created_at),
  };
}

function parsePayload(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function integerOrNull(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

function toDate(value: Date | string): Date {
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`invalid session story timestamp: ${String(value)}`);
  }
  return parsed;
}
