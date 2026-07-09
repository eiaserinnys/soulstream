import type {
  SessionHistoryProvider,
  SessionHistoryRawEvent,
} from "../session/session_history_service.js";
import type { LiveDbSqlResolver, LivePostgresSql } from "./live_db_sql.js";
import {
  buildToolTrace,
  serializeMessageRows,
  serializeTimelineRows,
  timelineToolUseIds,
  traceToolUseId,
  toolTimelineId,
} from "./live_timeline_serialization.js";

export type CreateLiveSessionHistoryProviderOptions = {
  readonly sqlResolver: LiveDbSqlResolver;
};

type Cursor = {
  readonly timestamp: string;
  readonly id: number | null;
};

const TIMELINE_EVENT_TYPES = [
  "user_message",
  "assistant_message",
  "tool_start",
  "tool_result",
  "error",
];
const LEGACY_TIMELINE_EVENT_TYPES = [
  ...TIMELINE_EVENT_TYPES,
  "complete",
];
const TRACE_EVENT_TYPES = [
  "tool_start",
  "tool_result",
  "progress",
  "debug",
  "system",
  "system_message",
];

export function createLiveSessionHistoryProvider(
  options: CreateLiveSessionHistoryProviderOptions,
): SessionHistoryProvider {
  return new LiveSessionHistoryProvider(options.sqlResolver);
}

class LiveSessionHistoryProvider implements SessionHistoryProvider {
  constructor(private readonly sqlResolver: LiveDbSqlResolver) {}

  async readViewport(sessionId: string, yMin: number, yMax: number): Promise<unknown> {
    const sql = await this.sqlResolver.resolveSql();
    await sql`
      SELECT COUNT(*)::int
      FROM events
      WHERE session_id = ${sessionId} AND parent_event_id IS NULL
    `;
    const rows = await sql`
      SELECT * FROM events_viewport(${sessionId}, ${yMin}, ${yMax})
    `;
    return rows.map((row) => ({
      ...row,
      payload: parsePayload(row.payload),
    }));
  }

  async readMessages(
    sessionId: string,
    before: string | null,
    limit: number,
  ): Promise<[unknown[], string | null]> {
    const sql = await this.sqlResolver.resolveSql();
    await sql`
      SELECT COUNT(*)::int
      FROM events
      WHERE session_id = ${sessionId} AND parent_event_id IS NULL
    `;
    const cursor = before === null ? null : decodeCursor(before);
    const rows = await readMessagePage(sql, sessionId, cursor, limit);
    const { pageRows, nextCursor } = pageRowsAndCursor(rows, limit);
    const withAncestors = await addMissingAncestors(sql, sessionId, pageRows);
    return [serializeMessageRows(sortDesc(withAncestors)), nextCursor];
  }

  async readTimeline(
    sessionId: string,
    before: string | null,
    limit: number,
  ): Promise<[unknown[], string | null]> {
    const sql = await this.sqlResolver.resolveSql();
    const assistantRows = await sql`
      SELECT EXISTS (
        SELECT 1 FROM events
        WHERE session_id = ${sessionId} AND event_type = 'assistant_message'
        LIMIT 1
      ) AS exists
    `;
    const hasAssistantMessage = assistantRows[0]?.exists === true;
    const eventTypes = hasAssistantMessage
      ? TIMELINE_EVENT_TYPES
      : LEGACY_TIMELINE_EVENT_TYPES;
    const cursor = before === null ? null : decodeCursor(before);
    const rows = await readTimelinePage(sql, sessionId, eventTypes, cursor, limit);
    const { pageRows, nextCursor } = pageRowsAndCursor(rows, limit);
    const withToolStarts = await addPairedToolStarts(sql, sessionId, pageRows);
    const messages = serializeTimelineRows(sortDesc(withToolStarts));
    return [
      hasAssistantMessage ? messages : synthesizeLegacyCompleteMessages(messages),
      nextCursor,
    ];
  }

  async readTimelineTrace(
    sessionId: string,
    timelineId: string,
  ): Promise<unknown | null | undefined> {
    const toolId = traceToolUseId(timelineId);
    if (toolId === null) return null;
    const sql = await this.sqlResolver.resolveSql();
    const rows = await sql`
      SELECT id, parent_event_id, event_type, payload, created_at
      FROM events
      WHERE session_id = ${sessionId}
        AND payload->>'tool_use_id' = ${toolId}
        AND event_type = ANY(${TRACE_EVENT_TYPES}::text[])
      ORDER BY created_at ASC, id ASC
    `;
    if (rows.length === 0) return null;
    return buildToolTrace(toolTimelineId(toolId), toolId, rows);
  }

  async readLastEventId(sessionId: string): Promise<number> {
    const sql = await this.sqlResolver.resolveSql();
    const rows = await sql`
      SELECT COALESCE(MAX(id), 0)::int AS last_event_id
      FROM events
      WHERE session_id = ${sessionId}
    `;
    return numberValue(rows[0]?.last_event_id) ?? 0;
  }

  async *streamEventsRaw(
    sessionId: string,
    afterId: number,
  ): AsyncIterable<SessionHistoryRawEvent> {
    const sql = await this.sqlResolver.resolveSql();
    const rows = await sql`
      SELECT * FROM event_stream_raw(${sessionId}, ${afterId})
      ORDER BY id ASC
    `;
    for (const row of rows) {
      yield {
        eventId: numberValue(row.id) ?? 0,
        eventType: String(row.event_type ?? ""),
        payloadText: payloadText(row.payload_text),
      };
    }
  }
}

async function readMessagePage(
  sql: LivePostgresSql,
  sessionId: string,
  cursor: Cursor | null,
  limit: number,
): Promise<readonly Record<string, unknown>[]> {
  if (cursor === null) {
    return sql`
      SELECT id, parent_event_id, event_type, payload, created_at
      FROM events
      WHERE session_id = ${sessionId}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit + 1}
    `;
  }
  if (cursor.id === null) {
    return sql`
      SELECT id, parent_event_id, event_type, payload, created_at
      FROM events
      WHERE session_id = ${sessionId}
        AND created_at < ${cursor.timestamp}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit + 1}
    `;
  }
  return sql`
    SELECT id, parent_event_id, event_type, payload, created_at
    FROM events
    WHERE session_id = ${sessionId}
      AND (
        created_at < ${cursor.timestamp}
        OR (created_at = ${cursor.timestamp} AND id < ${cursor.id})
      )
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit + 1}
  `;
}

async function readTimelinePage(
  sql: LivePostgresSql,
  sessionId: string,
  eventTypes: readonly string[],
  cursor: Cursor | null,
  limit: number,
): Promise<readonly Record<string, unknown>[]> {
  if (cursor === null) {
    return sql`
      SELECT id, parent_event_id, event_type, payload, created_at
      FROM events
      WHERE session_id = ${sessionId}
        AND event_type = ANY(${eventTypes}::text[])
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit + 1}
    `;
  }
  if (cursor.id === null) {
    return sql`
      SELECT id, parent_event_id, event_type, payload, created_at
      FROM events
      WHERE session_id = ${sessionId}
        AND event_type = ANY(${eventTypes}::text[])
        AND created_at < ${cursor.timestamp}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit + 1}
    `;
  }
  return sql`
    SELECT id, parent_event_id, event_type, payload, created_at
    FROM events
    WHERE session_id = ${sessionId}
      AND event_type = ANY(${eventTypes}::text[])
      AND (
        created_at < ${cursor.timestamp}
        OR (created_at = ${cursor.timestamp} AND id < ${cursor.id})
      )
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit + 1}
  `;
}

async function addMissingAncestors(
  sql: LivePostgresSql,
  sessionId: string,
  pageRows: readonly Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const seenIds = new Set(pageRows.flatMap((row) => maybeNumber(row.id)));
  const missingParents = pageRows.flatMap((row) => {
    const parentId = numberValue(row.parent_event_id);
    return parentId !== null && !seenIds.has(parentId) ? [parentId] : [];
  });
  if (missingParents.length === 0) return [...pageRows];
  const ancestorRows = await sql`
    WITH RECURSIVE ancestors AS (
      SELECT session_id, id, parent_event_id, event_type, payload, created_at
      FROM events
      WHERE session_id = ${sessionId} AND id = ANY(${missingParents}::int[])
      UNION
      SELECT e.session_id, e.id, e.parent_event_id, e.event_type, e.payload, e.created_at
      FROM events e
      JOIN ancestors a ON a.parent_event_id = e.id AND a.session_id = e.session_id
      WHERE e.session_id = ${sessionId}
    )
    SELECT id, parent_event_id, event_type, payload, created_at
    FROM ancestors
  `;
  const merged = [...pageRows];
  for (const row of ancestorRows) {
    const id = numberValue(row.id);
    if (id !== null && !seenIds.has(id)) {
      merged.push(row);
      seenIds.add(id);
    }
  }
  return merged;
}

async function addPairedToolStarts(
  sql: LivePostgresSql,
  sessionId: string,
  pageRows: readonly Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const toolUseIds = timelineToolUseIds(pageRows);
  if (toolUseIds.length === 0) return [...pageRows];
  const pairedStarts = await sql`
    SELECT id, parent_event_id, event_type, payload, created_at
    FROM events
    WHERE session_id = ${sessionId}
      AND event_type = 'tool_start'
      AND payload->>'tool_use_id' = ANY(${toolUseIds}::text[])
    ORDER BY created_at DESC, id DESC
  `;
  const seenIds = new Set(pageRows.flatMap((row) => maybeNumber(row.id)));
  const merged = [...pageRows];
  for (const row of pairedStarts) {
    const id = numberValue(row.id);
    if (id !== null && !seenIds.has(id)) {
      merged.push(row);
      seenIds.add(id);
    }
  }
  return merged;
}

function pageRowsAndCursor(
  rows: readonly Record<string, unknown>[],
  limit: number,
): { pageRows: Record<string, unknown>[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  if (!hasMore || pageRows.length === 0) {
    return { pageRows: [...pageRows], nextCursor: null };
  }
  const last = pageRows[pageRows.length - 1];
  return {
    pageRows: [...pageRows],
    nextCursor: `${isoCursor(last?.created_at)},${numberValue(last?.id) ?? 0}`,
  };
}

function synthesizeLegacyCompleteMessages(
  messages: Record<string, unknown>[],
): Record<string, unknown>[] {
  return messages.map((message) => {
    if (message.event_type !== "complete") return message;
    const payload = asRecord(message.payload) ?? {};
    return {
      ...message,
      event_type: "assistant_message",
      payload: {
        type: "assistant_message",
        content: payload.result ?? payload.content ?? payload.output ?? "",
      },
    };
  });
}

function sortDesc(
  rows: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  return [...rows].sort((left, right) => {
    const leftTime = timestampMs(left.created_at);
    const rightTime = timestampMs(right.created_at);
    if (leftTime !== rightTime) return rightTime - leftTime;
    return (numberValue(right.id) ?? 0) - (numberValue(left.id) ?? 0);
  });
}

function decodeCursor(cursor: string): Cursor {
  const index = cursor.lastIndexOf(",");
  if (index < 0) return { timestamp: cursor, id: null };
  const id = Number.parseInt(cursor.slice(index + 1), 10);
  return {
    timestamp: cursor.slice(0, index),
    id: Number.isInteger(id) ? id : null,
  };
}

function parsePayload(payload: unknown): unknown {
  if (typeof payload !== "string") return payload ?? {};
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return {};
  }
}

function payloadText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "{}";
  return JSON.stringify(value);
}

function isoCursor(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? "");
}

function timestampMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function maybeNumber(value: unknown): number[] {
  const parsed = numberValue(value);
  return parsed === null ? [] : [parsed];
}

function numberValue(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
