export const LAST_CHAT_MESSAGE_TYPES = [
  "user_message",
  "assistant_message",
] as const;

export type LastChatMessageType = typeof LAST_CHAT_MESSAGE_TYPES[number];

export type LastChatMessage = {
  readonly type: LastChatMessageType;
  /** Per-session durable event id. Legacy rows may omit it. */
  readonly eventId?: number;
  readonly preview: string;
  readonly timestamp: string;
};

export const PENDING_ATTENTION_KINDS = [
  "input_request",
  "permission",
  "tool_approval",
  "exit_plan_mode",
] as const;

export type PendingAttentionKind = typeof PENDING_ATTENTION_KINDS[number];

export type PendingAttention = {
  /** Stable within a session. It includes the kind so producer ids cannot collide. */
  readonly id: string;
  readonly sourceEventId: number;
  readonly sessionId: string;
  readonly kind: PendingAttentionKind;
  readonly requestedAt: string;
  readonly title: string;
  readonly body: string;
  readonly requestId?: string;
  readonly approvalId?: string;
  readonly toolUseId?: string;
  readonly toolName?: string;
  readonly questions?: readonly Record<string, unknown>[];
  readonly toolInput?: Readonly<Record<string, unknown>>;
  readonly timeoutSec?: number;
  readonly expiresAt?: string;
  /** The compact payload is insufficient; open detail before responding. */
  readonly requiresDetail: boolean;
};

export const SESSION_NOTICE_KINDS = [
  "terminal",
  "error",
  "intervention",
  "response_wait",
  "runtime_notification",
] as const;

export type SessionNoticeKind = typeof SESSION_NOTICE_KINDS[number];

export type SessionNotice = {
  /** `${sessionId}:${sourceEventId}`; suitable for browser-notification dedupe. */
  readonly id: string;
  readonly sourceEventId: number;
  readonly sessionId: string;
  readonly kind: SessionNoticeKind;
  readonly title: string;
  readonly body: string;
  readonly createdAt: string;
};

export type SessionFeedState = {
  readonly pendingAttentions: readonly PendingAttention[];
  /** Greatest durable event id that changed pendingAttentions. */
  readonly attentionRevision: number;
  /** Bounded newest-first window, not the complete notification history. */
  readonly recentNotices: readonly SessionNotice[];
  /** Greatest durable notice event id, including notices outside recentNotices. */
  readonly notificationWatermark: number;
  readonly noticesTruncated: boolean;
};

/**
 * Snapshot hydration is a bounded journal baseline. Clients must not display
 * browser notifications for hydrated entries. When noticesTruncated is true,
 * replace any local journal with recentNotices; the snapshot does not claim to
 * replay every notice that occurred during a global-ring gap.
 */
export type SessionFeedHydration = SessionFeedState;

export type SessionFeedDelta = {
  readonly attention_revision?: number;
  readonly pending_attentions_delta?: Readonly<
    Record<string, {
      /** Durable per-session source event id; clients apply monotonically per key. */
      readonly revision: number;
      readonly value: PendingAttention | null;
    }>
  >;
  readonly notices?: readonly SessionNotice[];
  readonly notification_watermark?: number;
};

export type SessionFeedUpdateWire = SessionFeedDelta & {
  readonly type: "session_updated";
  readonly agent_session_id: string;
  readonly status?: string;
  readonly updated_at?: string;
  readonly last_message?: LastChatMessage;
  readonly last_event_id?: number;
  readonly last_read_event_id?: number;
  readonly review_required?: boolean;
  readonly review_state?: "not_required" | "needs_review" | "acknowledged";
};

export type SessionHistoryResetReason = "cursor_ahead" | "history_gap";

export type SessionHistorySyncWire = {
  readonly type: "history_sync";
  /** max(requested cursor, current durable DB watermark); never regresses. */
  readonly last_event_id: number;
  readonly is_live: boolean;
  /** True means discard the local timeline cursor and refetch durable history. */
  readonly reset_required: boolean;
  readonly reset_reason?: SessionHistoryResetReason;
};

/** Opaque, stable for one producer message; clients compare but never parse it. */
export type LiveTextStreamIdentity = string;

export const LIVE_TEXT_SNAPSHOT_MAX_UTF8_BYTES = 256 * 1024;

export type LiveTextSnapshotStream = {
  readonly streamIdentity: LiveTextStreamIdentity;
  /** Complete accumulated text, or null when the byte cap was exceeded. */
  readonly text: string | null;
  readonly updatedAt: string;
  readonly truncated: boolean;
  /** When true, clear partial UI state and wait for the durable final message. */
  readonly resetRequired: boolean;
  readonly recovery: "none" | "durable_final";
};

export type LiveTextSnapshotWire = {
  readonly type: "text_snapshot";
  /** Durable history watermark used to assemble this connection. */
  readonly basedOnEventId: number;
  /** Discard queued/live events whose liveSeq is <= this boundary. */
  readonly throughLiveSeq: number;
  readonly streams: readonly LiveTextSnapshotStream[];
};

export type LiveTextEventMetadata = {
  readonly streamIdentity: LiveTextStreamIdentity;
  /** Monotonic within an orchestrator process and one session. */
  readonly liveSeq: number;
  /** Codex SDK sends cumulative text; app-server sends append-only deltas. */
  readonly liveTextMode: "replace" | "append";
};

export const EMPTY_SESSION_FEED_STATE: SessionFeedState = Object.freeze({
  pendingAttentions: [],
  attentionRevision: 0,
  recentNotices: [],
  notificationWatermark: 0,
  noticesTruncated: false,
});
