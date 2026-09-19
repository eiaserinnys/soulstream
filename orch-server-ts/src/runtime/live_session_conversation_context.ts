import type {
  SessionConversationContextQuery,
  SessionConversationContextResponse,
  SessionConversationMessage,
  SessionConversationTurn,
} from "../session/session_conversation_context.js";
import type { LiveDbSqlResolver, LivePostgresSql } from "./live_db_sql.js";

const TURN_START_EVENT_TYPES = [
  "user_message",
  "intervention_sent",
  "session_notification",
] as const;

const CONVERSATION_EVENT_TYPES = [
  ...TURN_START_EVENT_TYPES,
  "assistant_message",
  "complete",
] as const;

type EventRow = Record<string, unknown>;

export async function readLiveSessionConversationContext(
  sqlResolver: LiveDbSqlResolver,
  sessionId: string,
  query: SessionConversationContextQuery,
): Promise<SessionConversationContextResponse | null> {
  const sql = await sqlResolver.resolveSql();
  const match = query.eventId === null
    ? null
    : await readMatch(sql, sessionId, query.eventId);
  if (query.eventId !== null && match === null) return null;

  const anchorStartId = await resolveAnchorStartId(
    sql,
    sessionId,
    query.eventId,
    match,
  );
  const base = {
    session_id: sessionId,
    anchor: query.eventId === null
      ? "latest_conversation" as const
      : "match" as const,
    match_event_id: query.eventId,
  };
  if (anchorStartId === null) {
    return { ...base, match_turn_number: null, turns: [] };
  }

  const startIds = await readTurnStartWindow(
    sql,
    sessionId,
    anchorStartId,
    query.beforeTurns,
    query.afterTurns,
  );
  if (startIds.length === 0) {
    return { ...base, match_turn_number: null, turns: [] };
  }
  const nextBoundary = await readNextBoundary(
    sql,
    sessionId,
    startIds[startIds.length - 1]!,
  );
  const [summaries, messageRows] = await Promise.all([
    readTurnNumbers(sql, sessionId, startIds),
    readConversationMessages(sql, sessionId, startIds[0]!, nextBoundary),
  ]);
  const turns = buildTurns(startIds, anchorStartId, summaries, messageRows);
  return {
    ...base,
    match_turn_number:
      turns.find((turn) => turn.is_match)?.turn_number ?? null,
    turns,
  };
}

async function readMatch(
  sql: LivePostgresSql,
  sessionId: string,
  eventId: number,
): Promise<EventRow | null> {
  const rows = await sql`
    SELECT id, event_type, payload
    FROM events
    WHERE session_id = ${sessionId}
      AND id = ${eventId}
    LIMIT 1
    /* conversation_context_match */
  `;
  return rows[0] ?? null;
}

async function resolveAnchorStartId(
  sql: LivePostgresSql,
  sessionId: string,
  eventId: number | null,
  match: EventRow | null,
): Promise<number | null> {
  const summaryStartId = match?.event_type === "turn_summary"
    ? positiveInteger(recordValue(parseJson(match.payload)).turn_start_event_id)
    : null;
  if (summaryStartId !== null) {
    const rows = await sql`
      SELECT id
      FROM events
      WHERE session_id = ${sessionId}
        AND id = ${summaryStartId}
        AND event_type = ANY(${TURN_START_EVENT_TYPES}::text[])
      LIMIT 1
      /* conversation_context_anchor */
    `;
    return positiveInteger(rows[0]?.id);
  }
  const upperBound = eventId;
  const rows = upperBound === null
    ? await sql`
        SELECT id
        FROM events
        WHERE session_id = ${sessionId}
          AND event_type = ANY(${TURN_START_EVENT_TYPES}::text[])
        ORDER BY id DESC
        LIMIT 1
        /* conversation_context_anchor */
      `
    : await sql`
        SELECT id
        FROM events
        WHERE session_id = ${sessionId}
          AND id <= ${upperBound}
          AND event_type = ANY(${TURN_START_EVENT_TYPES}::text[])
        ORDER BY id DESC
        LIMIT 1
        /* conversation_context_anchor */
      `;
  return positiveInteger(rows[0]?.id);
}

async function readTurnStartWindow(
  sql: LivePostgresSql,
  sessionId: string,
  anchorStartId: number,
  beforeTurns: number,
  afterTurns: number,
): Promise<number[]> {
  const rows = await sql`
    WITH previous_turns AS (
      SELECT id
      FROM events
      WHERE session_id = ${sessionId}
        AND id < ${anchorStartId}
        AND event_type = ANY(${TURN_START_EVENT_TYPES}::text[])
      ORDER BY id DESC
      LIMIT ${beforeTurns}
    ), following_turns AS (
      SELECT id
      FROM events
      WHERE session_id = ${sessionId}
        AND id > ${anchorStartId}
        AND event_type = ANY(${TURN_START_EVENT_TYPES}::text[])
      ORDER BY id ASC
      LIMIT ${afterTurns}
    )
    SELECT id FROM previous_turns
    UNION ALL SELECT ${anchorStartId}::integer AS id
    UNION ALL SELECT id FROM following_turns
    ORDER BY id ASC
    /* conversation_context_turn_starts */
  `;
  return rows.map((row) => positiveInteger(row.id)).filter(isNumber);
}

async function readNextBoundary(
  sql: LivePostgresSql,
  sessionId: string,
  lastStartId: number,
): Promise<number | null> {
  const rows = await sql`
    SELECT id
    FROM events
    WHERE session_id = ${sessionId}
      AND id > ${lastStartId}
      AND event_type = ANY(${TURN_START_EVENT_TYPES}::text[])
    ORDER BY id ASC
    LIMIT 1
    /* conversation_context_next_boundary */
  `;
  return positiveInteger(rows[0]?.id);
}

async function readTurnNumbers(
  sql: LivePostgresSql,
  sessionId: string,
  startIds: readonly number[],
): Promise<Map<number, { turnNumber: number; finalResponseEventId: number | null }>> {
  const rows = await sql`
    WITH numbered_summaries AS (
      SELECT
        payload,
        ROW_NUMBER() OVER (ORDER BY id ASC)::integer AS turn_number
      FROM events
      WHERE session_id = ${sessionId}
        AND event_type = 'turn_summary'
    ), summary_anchors AS (
      SELECT
        turn_number,
        CASE
          WHEN payload->>'turn_start_event_id' ~ '^[1-9][0-9]*$'
          THEN (payload->>'turn_start_event_id')::integer
          ELSE NULL
        END AS turn_start_event_id,
        CASE
          WHEN payload->>'final_response_event_id' ~ '^[1-9][0-9]*$'
          THEN (payload->>'final_response_event_id')::integer
          ELSE NULL
        END AS final_response_event_id
      FROM numbered_summaries
    )
    SELECT
      turn_number,
      turn_start_event_id,
      final_response_event_id
    FROM summary_anchors
    WHERE turn_start_event_id = ANY(${startIds}::int[])
    ORDER BY turn_number ASC
    /* conversation_context_turn_numbers */
  `;
  const summaries = new Map<number, {
    turnNumber: number;
    finalResponseEventId: number | null;
  }>();
  for (const row of rows) {
    const startId = positiveInteger(row.turn_start_event_id);
    const turnNumber = positiveInteger(row.turn_number);
    if (startId === null || turnNumber === null) continue;
    summaries.set(startId, {
      turnNumber,
      finalResponseEventId: positiveInteger(row.final_response_event_id),
    });
  }
  return summaries;
}

async function readConversationMessages(
  sql: LivePostgresSql,
  sessionId: string,
  firstStartId: number,
  nextBoundary: number | null,
): Promise<EventRow[]> {
  const rows = nextBoundary === null
    ? await sql`
        SELECT id, event_type, payload, created_at
        FROM events
        WHERE session_id = ${sessionId}
          AND id >= ${firstStartId}
          AND event_type = ANY(${CONVERSATION_EVENT_TYPES}::text[])
        ORDER BY id ASC
        /* conversation_context_messages */
      `
    : await sql`
        SELECT id, event_type, payload, created_at
        FROM events
        WHERE session_id = ${sessionId}
          AND id >= ${firstStartId}
          AND id < ${nextBoundary}
          AND event_type = ANY(${CONVERSATION_EVENT_TYPES}::text[])
        ORDER BY id ASC
        /* conversation_context_messages */
      `;
  return [...rows];
}

function buildTurns(
  startIds: readonly number[],
  anchorStartId: number,
  summaries: ReadonlyMap<number, {
    readonly turnNumber: number;
    readonly finalResponseEventId: number | null;
  }>,
  rows: readonly EventRow[],
): SessionConversationTurn[] {
  return startIds.map((startId, index) => {
    const nextStartId = startIds[index + 1] ?? Number.POSITIVE_INFINITY;
    const messages = rows
      .filter((row) => {
        const id = positiveInteger(row.id);
        return id !== null && id >= startId && id < nextStartId;
      })
      .map(normalizeConversationMessage)
      .filter((message): message is SessionConversationMessage => message !== null);
    const summary = summaries.get(startId);
    const lastAssistantId = messages.reduce<number | null>(
      (latest, message) => message.role === "assistant" ? message.event_id : latest,
      null,
    );
    return {
      turn_number: summary?.turnNumber ?? null,
      turn_start_event_id: startId,
      final_response_event_id:
        summary?.finalResponseEventId ?? lastAssistantId,
      is_match: startId === anchorStartId,
      messages,
    };
  });
}

function normalizeConversationMessage(row: EventRow): SessionConversationMessage | null {
  const eventId = positiveInteger(row.id);
  const eventType = String(row.event_type ?? "");
  const payload = recordValue(parseJson(row.payload));
  if (eventId === null) return null;
  const role = eventType === "assistant_message" || eventType === "complete"
    ? "assistant" as const
    : eventType === "session_notification"
      ? "system" as const
      : "user" as const;
  const text = messageText(eventType, payload).trim();
  if (text.length === 0) return null;
  return {
    event_id: eventId,
    event_type: eventType,
    role,
    text,
    created_at: iso(row.created_at),
  };
}

function messageText(eventType: string, payload: Record<string, unknown>): string {
  const value = eventType === "assistant_message"
    ? payload.content
    : eventType === "complete"
      ? payload.result ?? payload.content ?? payload.output
      : payload.text ?? payload.message ?? payload.content;
  return contentText(value);
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((item) => {
    if (typeof item === "string") return [item];
    const record = recordValue(item);
    const text = record.text ?? record.content;
    return typeof text === "string" ? [text] : [];
  }).join("\n");
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function isNumber(value: number | null): value is number {
  return value !== null;
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const date = new Date(String(value ?? ""));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}
