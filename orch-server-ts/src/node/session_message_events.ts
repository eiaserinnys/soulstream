import type { PerNodeSessionCache } from "./session_cache.js";
import type { NodeRegistryEvent } from "./registry_types.js";

export function collectDirectNodeSessionEvents(params: {
  sessionCache: PerNodeSessionCache;
  nodeId: string;
  connectionId: string;
  message: Record<string, unknown>;
  nowMs: number;
  committedIngress?: boolean;
}): NodeRegistryEvent[] | undefined {
  if (params.message.type === "session_created") {
    const data = stripUncommittedSessionFeedFields(params.message);
    params.sessionCache.upsertFromSessionCreated({ ...params, message: data });
    return [
      {
        type: "node_session_session_created",
        nodeId: params.nodeId,
        data,
      },
    ];
  }

  if (params.message.type === "session_updated") {
    const data = params.committedIngress === true
      ? params.message
      : stripUncommittedSessionFeedFields(params.message);
    params.sessionCache.upsertFromSessionUpdated({ ...params, message: data });
    return [
      {
        type: "node_session_session_updated",
        nodeId: params.nodeId,
        data,
        ...(params.committedIngress === true ? { committedIngress: true } : {}),
      },
    ];
  }

  if (params.message.type === "session_deleted") {
    params.sessionCache.deleteFromSessionDeleted({ message: params.message });
    return [
      {
        type: "node_session_session_deleted",
        nodeId: params.nodeId,
        data: params.message,
      },
    ];
  }

  if (params.message.type === "catalog_updated") {
    return [
      {
        type: "node_session_event",
        nodeId: params.nodeId,
        data: params.message,
      },
    ];
  }

  return undefined;
}

const COMMITTED_SESSION_FEED_FIELDS = new Set([
  "last_message",
  "lastMessage",
  "pending_attentions",
  "pendingAttentions",
  "attention_revision",
  "attentionRevision",
  "pending_attentions_delta",
  "pendingAttentionsDelta",
  "recent_notices",
  "recentNotices",
  "notices",
  "notification_watermark",
  "notificationWatermark",
  "notices_truncated",
  "noticesTruncated",
]);

export function stripUncommittedSessionFeedFields(
  message: Record<string, unknown>,
): Record<string, unknown> {
  const stripped = stripFeedFields(message);
  if (isRecord(stripped.session)) {
    stripped.session = stripFeedFields(stripped.session);
  }
  return stripped;
}

function stripFeedFields(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(
    ([key]) => !COMMITTED_SESSION_FEED_FIELDS.has(key),
  ));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
