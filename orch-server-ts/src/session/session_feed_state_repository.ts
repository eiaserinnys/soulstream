import type { LivePostgresSql } from "../runtime/live_db_sql.js";
import {
  EMPTY_SESSION_FEED_STATE,
  type PendingAttention,
  type SessionFeedState,
  type SessionNotice,
} from "./session_feed_contract.js";

export const SESSION_FEED_RECENT_NOTICE_LIMIT = 8;

/** Loads all compact feed state in three page-batched queries (never per row). */
export async function loadSessionFeedStates(
  sql: LivePostgresSql,
  sessionRows: readonly Record<string, unknown>[],
): Promise<Map<string, SessionFeedState>> {
  const sessionIds = sessionRows.flatMap((row) => {
    const value = row.session_id ?? row.agent_session_id ?? row.agentSessionId;
    return typeof value === "string" && value.length > 0 ? [value] : [];
  });
  const uniqueIds = [...new Set(sessionIds)];
  if (uniqueIds.length === 0) return new Map();

  const [stateRows, attentionRows, noticeRows] = await Promise.all([
    sql`
      SELECT session_id, attention_revision, notification_watermark,
             notification_count
      FROM session_feed_state
      WHERE session_id = ANY(${uniqueIds}::text[])
    `,
    sql`
      SELECT session_id, projection
      FROM session_pending_attentions
      WHERE session_id = ANY(${uniqueIds}::text[])
      ORDER BY session_id, source_event_id ASC, attention_id ASC
    `,
    sql`
      WITH ranked AS (
        SELECT session_id, projection,
               ROW_NUMBER() OVER (
                 PARTITION BY session_id
                 ORDER BY source_event_id DESC
               ) AS row_number
        FROM session_feed_notices
        WHERE session_id = ANY(${uniqueIds}::text[])
      )
      SELECT session_id, projection
      FROM ranked
      WHERE row_number <= ${SESSION_FEED_RECENT_NOTICE_LIMIT}
      ORDER BY session_id, row_number ASC
    `,
  ]);

  const mutable = new Map<string, MutableFeedState>();
  for (const sessionId of uniqueIds) mutable.set(sessionId, emptyMutableState());
  for (const row of stateRows) {
    const sessionId = nonEmptyString(row.session_id);
    if (sessionId === null) continue;
    const state = mutable.get(sessionId) ?? emptyMutableState();
    state.attentionRevision = nonNegativeInteger(row.attention_revision);
    state.notificationWatermark = nonNegativeInteger(row.notification_watermark);
    state.notificationCount = nonNegativeInteger(row.notification_count);
    mutable.set(sessionId, state);
  }
  for (const row of attentionRows) {
    const sessionId = nonEmptyString(row.session_id);
    const attention = normalizePendingAttention(parseJson(row.projection));
    if (sessionId === null || attention === null || attention.sessionId !== sessionId) {
      continue;
    }
    const state = mutable.get(sessionId) ?? emptyMutableState();
    state.pendingAttentions.push(attention);
    mutable.set(sessionId, state);
  }
  for (const row of noticeRows) {
    const sessionId = nonEmptyString(row.session_id);
    const notice = normalizeSessionNotice(parseJson(row.projection));
    if (sessionId === null || notice === null || notice.sessionId !== sessionId) {
      continue;
    }
    const state = mutable.get(sessionId) ?? emptyMutableState();
    state.recentNotices.push(notice);
    mutable.set(sessionId, state);
  }

  return new Map([...mutable].map(([sessionId, state]) => [sessionId, {
    pendingAttentions: state.pendingAttentions,
    attentionRevision: state.attentionRevision,
    recentNotices: state.recentNotices,
    notificationWatermark: state.notificationWatermark,
    noticesTruncated: state.notificationCount > state.recentNotices.length,
  }]));
}

export function sessionFeedStateOrEmpty(
  states: ReadonlyMap<string, SessionFeedState>,
  sessionId: string,
): SessionFeedState {
  return states.get(sessionId) ?? EMPTY_SESSION_FEED_STATE;
}

type MutableFeedState = {
  pendingAttentions: PendingAttention[];
  attentionRevision: number;
  recentNotices: SessionNotice[];
  notificationWatermark: number;
  notificationCount: number;
};

function emptyMutableState(): MutableFeedState {
  return {
    pendingAttentions: [],
    attentionRevision: 0,
    recentNotices: [],
    notificationWatermark: 0,
    notificationCount: 0,
  };
}

function normalizePendingAttention(value: unknown): PendingAttention | null {
  if (!isRecord(value)) return null;
  const id = nonEmptyString(value.id);
  const sessionId = nonEmptyString(value.sessionId);
  const sourceEventId = positiveInteger(value.sourceEventId);
  const requestedAt = isoString(value.requestedAt);
  const kind = value.kind;
  if (
    id === null || sessionId === null || sourceEventId === null ||
    requestedAt === null ||
    !["input_request", "permission", "tool_approval", "exit_plan_mode"].includes(
      String(kind),
    ) ||
    typeof value.title !== "string" || typeof value.body !== "string" ||
    typeof value.requiresDetail !== "boolean"
  ) return null;
  return value as PendingAttention;
}

function normalizeSessionNotice(value: unknown): SessionNotice | null {
  if (!isRecord(value)) return null;
  const id = nonEmptyString(value.id);
  const sessionId = nonEmptyString(value.sessionId);
  const sourceEventId = positiveInteger(value.sourceEventId);
  const createdAt = isoString(value.createdAt);
  if (
    id === null || sessionId === null || sourceEventId === null ||
    createdAt === null ||
    !["terminal", "error", "intervention", "response_wait", "runtime_notification"]
      .includes(String(value.kind)) ||
    typeof value.title !== "string" || typeof value.body !== "string"
  ) return null;
  return value as SessionNotice;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function isoString(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return value;
}
