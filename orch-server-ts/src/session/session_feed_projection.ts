import type {
  LastChatMessage,
  LastChatMessageType,
  SessionFeedState,
} from "./session_feed_contract.js";

export const SESSION_FEED_PROMPT_LIMIT = 200;

const FEED_SUMMARY_KEYS = [
  "agentSessionId",
  "status",
  "reviewRequired",
  "reviewState",
  "createdAt",
  "updatedAt",
  "sessionType",
  "prompt",
  "lastMessage",
  "clientId",
  "displayName",
  "nodeId",
  "folderId",
  "lastEventId",
  "lastReadEventId",
  "callerSessionId",
  "predecessorSessionId",
  "agentId",
  "agentName",
  "agentPortraitUrl",
  "backend",
  "modelPreset",
  "modelLabel",
  "model",
  "reasoningEffort",
  "userName",
  "userPortraitUrl",
  "terminationReason",
  "terminationDetail",
  "bindingWarnings",
  "pendingAttentions",
  "attentionRevision",
  "recentNotices",
  "notificationWatermark",
  "noticesTruncated",
] as const;

const FEED_UPDATE_FIELDS = [
  ["status", "status"],
  ["updated_at", "updated_at", "updatedAt"],
  ["last_message", "last_message", "lastMessage"],
  ["last_event_id", "last_event_id", "lastEventId"],
  ["last_read_event_id", "last_read_event_id", "lastReadEventId"],
  ["review_required", "review_required", "reviewRequired"],
  ["review_state", "review_state", "reviewState"],
  ["termination_reason", "termination_reason", "terminationReason"],
  ["termination_detail", "termination_detail", "terminationDetail"],
  ["termination_event_id", "termination_event_id", "terminationEventId"],
  ["attention_revision", "attention_revision"],
  ["pending_attentions_delta", "pending_attentions_delta"],
  ["notices", "notices"],
  ["notification_watermark", "notification_watermark"],
  ["userName", "userName"],
  ["userPortraitUrl", "userPortraitUrl"],
] as const;

const LAST_CHAT_TYPES = new Set<LastChatMessageType>([
  "user_message",
  "assistant_message",
]);

export function normalizeLastChatMessage(value: unknown): LastChatMessage | null {
  if (!isRecord(value) || !LAST_CHAT_TYPES.has(value.type as LastChatMessageType)) {
    return null;
  }
  if (typeof value.preview !== "string") return null;
  const preview = value.preview.trim();
  if (preview.length === 0) return null;
  if (typeof value.timestamp !== "string" || !Number.isFinite(Date.parse(value.timestamp))) {
    return null;
  }
  const eventId = positiveInteger(value.eventId ?? value.event_id);
  return {
    type: value.type as LastChatMessageType,
    preview: truncateCodepoints(preview, SESSION_FEED_PROMPT_LIMIT),
    timestamp: new Date(value.timestamp).toISOString(),
    ...(eventId === undefined ? {} : { eventId }),
  };
}

export function projectSessionFeedSummary(
  session: Record<string, unknown>,
): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const key of FEED_SUMMARY_KEYS) {
    if (Object.hasOwn(session, key)) summary[key] = session[key];
  }
  if (typeof summary.prompt === "string") {
    summary.prompt = truncateCodepoints(summary.prompt, SESSION_FEED_PROMPT_LIMIT);
  }
  summary.lastMessage = normalizeLastChatMessage(summary.lastMessage);
  summary.pendingAttentions = Array.isArray(summary.pendingAttentions)
    ? summary.pendingAttentions
    : [];
  summary.attentionRevision = nonNegativeInteger(summary.attentionRevision);
  summary.recentNotices = Array.isArray(summary.recentNotices)
    ? summary.recentNotices
    : [];
  summary.notificationWatermark = nonNegativeInteger(summary.notificationWatermark);
  summary.noticesTruncated = summary.noticesTruncated === true;
  return summary;
}

/**
 * Public session_updated is a semantic patch, not a serialized session row.
 * Keeping this allowlist separate prevents cache-only/raw fields from leaking
 * back into the global replay ring when producers add fields.
 */
export function projectSessionFeedUpdate(
  update: Record<string, unknown>,
): ({
  type: "session_updated";
  agent_session_id: string;
  [key: string]: unknown;
}) | null {
  const sessionId = stringValue(update.agent_session_id ?? update.agentSessionId);
  if (sessionId === null) return null;
  const projected: {
    type: "session_updated";
    agent_session_id: string;
    [key: string]: unknown;
  } = {
    type: "session_updated",
    agent_session_id: sessionId,
  };
  for (const [target, ...sources] of FEED_UPDATE_FIELDS) {
    for (const source of sources) {
      if (!Object.hasOwn(update, source)) continue;
      projected[target] = update[source];
      break;
    }
  }
  if (Object.hasOwn(projected, "last_message")) {
    projected.last_message = normalizeLastChatMessage(projected.last_message);
    if (projected.last_message === null) delete projected.last_message;
  }
  return projected;
}

export function withSessionFeedState(
  session: Record<string, unknown>,
  state: SessionFeedState,
): Record<string, unknown> {
  return {
    ...session,
    pendingAttentions: [...state.pendingAttentions],
    attentionRevision: state.attentionRevision,
    recentNotices: [...state.recentNotices],
    notificationWatermark: state.notificationWatermark,
    noticesTruncated: state.noticesTruncated,
  };
}

export function sessionFeedActivityMs(session: Record<string, unknown>): number {
  const lastMessage = normalizeLastChatMessage(
    session.lastMessage ?? session.last_message,
  );
  return timestampMs(lastMessage?.timestamp)
    ?? timestampMs(session.createdAt ?? session.created_at)
    ?? timestampMs(session.updatedAt ?? session.updated_at)
    ?? 0;
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value !== "string" && !(value instanceof Date)) return undefined;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function nonNegativeInteger(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function truncateCodepoints(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
