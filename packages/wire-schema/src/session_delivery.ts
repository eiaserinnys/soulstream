export const DELIVERY_INTENTS = [
  "human_live_steer",
  "durable_next_turn",
  "completion_notification",
  "runtime_followup",
] as const;

export type DeliveryIntent = (typeof DELIVERY_INTENTS)[number];

export const DELIVERY_STATES = [
  "pending",
  "claimed",
  "dispatching",
  "queued",
  "delivered",
  "consumed",
  "superseded",
  "uncertain",
] as const;

export type DeliveryState = (typeof DELIVERY_STATES)[number];

export const DELIVERY_AGGREGATE_STATES = [
  "pending",
  "delivered",
  "consumed",
  "dead_letter",
] as const;

export type DeliveryAggregateState = (typeof DELIVERY_AGGREGATE_STATES)[number];

export function isDeliveryIntent(value: unknown): value is DeliveryIntent {
  return (
    typeof value === "string" &&
    DELIVERY_INTENTS.includes(value as DeliveryIntent)
  );
}

export interface SessionDeliveryRow {
  delivery_id: string;
  enqueue_sequence?: string | number;
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
  payload_hash: string;
  payload: Record<string, unknown>;
  state: DeliveryState;
  aggregate_state: DeliveryAggregateState;
  created_at: Date;
  updated_at: Date;
  claimed_at: Date | null;
  dispatching_at: Date | null;
  attempt_token: string | null;
  attempt_expires_at: Date | null;
  attempt_count: number;
  next_attempt_at: Date;
  last_error: string | null;
  queued_at: Date | null;
  delivered_at: Date | null;
  consumed_at: Date | null;
  superseded_at: Date | null;
  superseded_terminal_revision: string | null;
  target_receipt_id: string | null;
  target_receipt_at: Date | null;
  consumed_reason: string | null;
  dead_letter_reason: string | null;
  dead_lettered_at: Date | null;
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

export type RecordObservedChildCompletionFailure =
  Exclude<RecordObservedChildCompletionResult, "recorded">;

export type RecordObservedChildCompletionBatchResult =
  | { status: "recorded" }
  | {
      status: RecordObservedChildCompletionFailure;
      childSessionId: string;
    };

export interface SessionDeliveryNotificationOutboxRow {
  delivery_id: string;
  target_session_id: string;
  payload: Record<string, unknown>;
  disposition: "queued" | "auto_resume";
  state: "pending" | "claimed" | "published" | "dead_letter";
  projection_state: "staged" | "publishing" | "published" | "discarded";
  target_receipt_id: string | null;
  target_receipt_at: Date | null;
  attempt_token: string | null;
  attempt_expires_at: Date | null;
  attempt_count: number;
  next_attempt_at: Date;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  published_at: Date | null;
  dead_lettered_at: Date | null;
}
