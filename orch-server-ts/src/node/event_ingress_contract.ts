import type {
  EventAppendAck as WireEventAppendAck,
  EventAppendBatch as WireEventAppendBatch,
  EventCanonicalExecutionOwnershipProjection as WireEventCanonicalExecutionOwnershipProjection,
  EventCanonicalExecutionRegistrationProjection as WireEventCanonicalExecutionRegistrationProjection,
  EventCanonicalSessionProjection as WireEventCanonicalSessionProjection,
  EventSessionEffectApplication as WireEventSessionEffectApplication,
} from "@soulstream/wire-schema";

export type EventSessionEffect = NonNullable<WireEventAppendBatch["events"][number]["session_effect"]>;

/**
 * 등록 번호가 낡아도 세션 기록으로 남기는 사건의 명시 목록.
 *
 * session_effect가 없는 일반 기록 사건(답, 도구, 훅, 턴 끝 후보)과 last_message만
 * 해당한다. last_message의 늦은 도착은 SQL 함수 session_apply_last_chat_message의
 * (created_at, event_id) 순서 보호가 정리하므로 따로 건너뛰지 않는다.
 *
 * 그 밖의 효과(execution_registration, execution_acquire, running_transition,
 * terminal_transition, set_backend_session_id, rotate_backend_session_id,
 * append_metadata)는 낡은 등록이 새 실행의 중앙 상태를 덮지 않도록 거절한다(설계 R5).
 * gatedSessionCommand()로 넓히면 세션 행 효과까지 풀린다. 세션 결정 기계의
 * stale_registration 사실 값도 이 목록에서 만든다.
 */
export const RECORDABLE_STALE_EFFECT_KINDS = ["last_message"] as const;

export function recordsDespiteStaleRegistration(
  effect: EventSessionEffect | null,
): boolean {
  return effect === null
    || (RECORDABLE_STALE_EFFECT_KINDS as readonly string[]).includes(effect.kind);
}

export type EventIngressEnvelope = {
  stream_id: string;
  source_seq: number;
  session_id: string;
  registration_id?: string | null;
  event_type: string;
  payload: unknown;
  searchable_text: string | null;
  created_at: string;
  semantic_dedupe_key: string | null;
  session_effect: EventSessionEffect | null;
  payload_hash: string;
};

export type EventAppendBatch = {
  type: "event_append_batch";
  protocol_version: 1;
  stream_id: string;
  first_seq: number;
  events: EventIngressEnvelope[];
};

export type EventAppendAck = Pick<
  WireEventAppendAck,
  "type" | "stream_id" | "acked_through"
> & { events: EventAppendAcknowledgement[] };

export type EventAppendAcknowledgement = WireEventAppendAck["events"][number];

type WireShape<T> = { [K in keyof T]: T[K] };

export type EventCanonicalSessionProjection =
  WireShape<WireEventCanonicalSessionProjection>;

export type EventCanonicalExecutionOwnershipProjection =
  WireShape<WireEventCanonicalExecutionOwnershipProjection>;

export type EventCanonicalExecutionRegistrationProjection =
  WireShape<WireEventCanonicalExecutionRegistrationProjection>;

export const EVENT_SESSION_REJECTION_REASONS = [
  "already_terminal",
  "session_missing",
  "owner_node_changed",
  "worktree_busy",
  "worktree_not_ready",
] as const satisfies readonly EventSessionRejectionReason[];
export type EventSessionRejectionReason =
  NonNullable<WireEventSessionEffectApplication["rejection_reason"]>;

export type EventSessionEffectApplication = {
  applied: boolean;
  canonicalSession: EventCanonicalSessionProjection | null;
  /** Internal public-feed materialization; never added to the worker ACK v1. */
  canonicalLastMessage?: import("../session/session_feed_contract.js").LastChatMessage | null;
  canonicalExecutionRegistration?: EventCanonicalExecutionRegistrationProjection | null;
  /** One-release response compatibility for a legacy execution_acquire. */
  canonicalExecutionOwnership?: EventCanonicalExecutionOwnershipProjection | null;
  /** 세션 기계가 거절한 까닭. 사유를 싣지 않는 기계 사유도 있다. */
  rejectionReason?: EventSessionRejectionReason;
};

export type EventSessionEffectApplicationWire = {
  applied: boolean;
  canonical_session: EventCanonicalSessionProjection;
  canonical_execution_registration?: EventCanonicalExecutionRegistrationProjection | null;
  /** One-release response compatibility for a legacy execution_acquire. */
  canonical_execution_ownership?: EventCanonicalExecutionOwnershipProjection | null;
  rejection_reason?: EventSessionRejectionReason;
};

/**
 * 사건의 등록 번호와 세션의 지금 execution_registration_id가 달랐던 수신의
 * 진단 정보. 기록 여부와 무관하게 운영 로그가 사건과 세션의 번호를 함께 남길 때 쓴다.
 */
export type EventIngressRegistrationMismatch = {
  eventRegistrationId: string | null;
  sessionExecutionRegistrationId: string | null;
};

export type CommittedIngressEvent = {
  outcome?: "committed";
  envelope: EventIngressEnvelope;
  eventId: number;
  duplicateReceipt: boolean;
  /** 낡은 등록 번호로 들어왔지만 기록한 사건의 진단 정보. */
  registrationMismatch?: EventIngressRegistrationMismatch;
  sessionEffectApplication?: EventSessionEffectApplication;
  feedProjectionApplication?: import("./event_feed_projection_applier.js").EventFeedProjectionApplication;
  /** Durable raw-coordinate watermark for actual public-feed changes only. */
  feedLastEventId?: number;
};

export type DeadLetteredIngressEvent = {
  outcome: "dead_lettered";
  envelope: EventIngressEnvelope;
  deadLetter: {
    code: string;
    reason: string;
    rejectedAt: string;
    path: string;
  };
  /** 등록 번호 불일치로 거절한 수신의 진단 정보. */
  registrationMismatch?: EventIngressRegistrationMismatch;
};

export type EventIngressResult = CommittedIngressEvent | DeadLetteredIngressEvent;

export function isEventAppendBatchFrame(frame: Record<string, unknown>): boolean {
  return frame.type === "event_append_batch";
}
