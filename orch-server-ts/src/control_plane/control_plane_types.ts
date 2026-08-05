import type postgres from "postgres";

export type DeliveryIntent =
  | "human_live_steer"
  | "durable_next_turn"
  | "completion_notification"
  | "runtime_followup";

export type DeliveryState =
  | "pending"
  | "claimed"
  | "dispatching"
  | "queued"
  | "delivered"
  | "consumed"
  | "uncertain";

export interface SessionDeliveryRow {
  delivery_id: string;
  target_session_id: string | null;
  source_session_id: string | null;
  relation_key: string;
  completion_id: string | null;
  intent: DeliveryIntent;
  source: string;
  producer_kind: string | null;
  producer_id: string | null;
  producer_terminal_revision: string | null;
  parent_delivery_id: string | null;
  caller_turn_id: string | null;
  supervisor_role: string | null;
  payload_hash: string;
  payload: Record<string, unknown>;
  state: DeliveryState;
  created_at: Date;
  updated_at: Date;
  claimed_at: Date | null;
  dispatching_at: Date | null;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  attempt_count: number;
  next_attempt_at: Date;
  last_error: string | null;
  queued_at: Date | null;
  delivered_at: Date | null;
  consumed_at: Date | null;
}

export interface RegisterSessionDeliveryParams {
  deliveryId: string;
  targetSessionId?: string | null;
  sourceSessionId?: string | null;
  relationKey: string;
  completionId?: string | null;
  intent: DeliveryIntent;
  source: string;
  producerKind?: string | null;
  producerId?: string | null;
  producerTerminalRevision?: string | null;
  parentDeliveryId?: string | null;
  callerTurnId?: string | null;
  supervisorRole?: string | null;
  payloadHash: string;
  payload: Record<string, unknown>;
  createdAt?: Date;
}

export interface RegisterSessionDeliveryResult {
  row: SessionDeliveryRow;
  inserted: boolean;
  conflict: boolean;
}

export interface SessionDeliveryRelationConsumptionRow {
  relation_key: string;
  completion_id: string;
  caller_session_id: string;
  consumed_turn_id: string;
  consumed_at: Date;
}

export interface RecordSessionDeliveryRelationConsumptionParams {
  relationKey: string;
  completionId: string;
  callerSessionId: string;
  consumedTurnId: string;
}

export interface RecordSessionDeliveryRelationConsumptionResult {
  relation: SessionDeliveryRelationConsumptionRow;
  relationInserted: boolean;
  deliveryConsumed: boolean;
}

export interface RecordObservedChildCompletionParams
  extends RecordSessionDeliveryRelationConsumptionParams {
  childSessionId: string;
  observedRevision: number;
}

export type RecordObservedChildCompletionResult =
  | "recorded"
  | "not_found"
  | "not_child_caller"
  | "not_terminal"
  | "missing_terminal_revision"
  | "revision_mismatch";

export type RecordObservedChildCompletionBatchResult =
  | { status: "recorded" }
  | {
      status: Exclude<RecordObservedChildCompletionResult, "recorded">;
      childSessionId: string;
    };

export interface SessionDeliveryNotificationOutboxRow {
  delivery_id: string;
  target_session_id: string;
  payload: Record<string, unknown>;
  disposition: "queued" | "auto_resume";
  state: "pending" | "claimed" | "published";
  lease_owner: string | null;
  lease_expires_at: Date | null;
  attempt_count: number;
  next_attempt_at: Date;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  published_at: Date | null;
}

export interface AppendSupervisorEventParams {
  sourceNode: string;
  sourceSessionId: string;
  sourceEventId: number;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface SupervisorAppendResult {
  offset: number;
  inserted: boolean;
  contiguousUpto: number;
  highestSeenEventId: number;
  gapStart: number | null;
  gapEnd: number | null;
}

export interface SupervisorEventRow {
  offset: number;
  sourceNode: string;
  sourceSessionId: string;
  sourceEventId: number;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: Date;
  insertedAt: Date;
}

export interface SupervisorSourceCursorRow {
  sourceNode: string;
  sourceSessionId: string;
  contiguousUpto: number;
  highestSeenEventId: number;
  gapStart: number | null;
  gapEnd: number | null;
  updatedAt: Date;
}

export type SupervisorWakeDispatchState = "active" | "retrying" | "blocked";

export interface SupervisorRegistryUpsertParams {
  role: string;
  activeSessionId: string | null;
  epoch: number;
  cursorOffset: number;
  handoverState: string;
  cumulativeTokens: number;
  compactionCount: number;
  lastSeenAt: Date | null;
}

export interface SupervisorRegistryRow extends SupervisorRegistryUpsertParams {
  wakeDispatchState?: SupervisorWakeDispatchState;
  wakeLastSignature?: string | null;
  wakeRepeatCount?: number;
  wakeBlockedReason?: string | null;
  wakeBlockedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SupervisorWakeDispatchStateParams {
  role: string;
  state: SupervisorWakeDispatchState;
  lastSignature?: string | null;
  repeatCount: number;
  blockedReason?: string | null;
  blockedAt?: Date | null;
}

export interface ClaudeTranscriptKey {
  projectKey: string;
  sessionId: string;
  subpath?: string | null;
}

export type ClaudeTranscriptEntry = {
  type: string;
  uuid?: string;
  timestamp?: string;
  [key: string]: unknown;
};

export interface ClaudeTranscriptSessionSummary {
  sessionId: string;
  mtime: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SqlClient = postgres.Sql<any>;
