export const RUNTIME_FOLLOWUP_SESSION_ID =
  "eb6b0000-0000-4000-8000-000000000001";
export const RUNTIME_FOLLOWUP_NODE_ID = "eiaserinnys-fixture";

export const RECONNECT_PENDING_DELIVERY_IDS = [
  "51700000-0000-4000-8000-000000000001",
  "51710000-0000-4000-8000-000000000001",
  "51720000-0000-4000-8000-000000000001",
] as const;

export const ACTIVE_TURN_DELIVERY_IDS = [
  "51730000-0000-4000-8000-000000000001",
  "51740000-0000-4000-8000-000000000001",
] as const;

export const ALL_RUNTIME_FOLLOWUP_DELIVERY_IDS = [
  ...RECONNECT_PENDING_DELIVERY_IDS,
  ...ACTIVE_TURN_DELIVERY_IDS,
] as const;

export interface RuntimeFollowupFixtureRow {
  delivery_id: string;
  enqueue_sequence: number;
  target_session_id: string;
  source_session_id: null;
  relation_key: string;
  completion_id: string;
  intent: "runtime_followup";
  source: "claude_runtime_task_followup";
  producer_kind: "claude_runtime_task";
  producer_id: string;
  producer_terminal_revision: string;
  parent_delivery_id: null;
  caller_turn_id: null;
  payload_hash: string;
  payload: Record<string, unknown>;
  state: "pending" | "claimed" | "queued" | "consumed";
  aggregate_state: "pending" | "consumed";
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
  superseded_at: Date | null;
  superseded_terminal_revision: string | null;
  target_receipt_id: string | null;
  target_receipt_at: Date | null;
  consumed_reason: string | null;
  dead_letter_reason: string | null;
  dead_lettered_at: Date | null;
}

export function runtimeFollowupRow(
  deliveryId: string,
  enqueueSequence: number,
): RuntimeFollowupFixtureRow {
  const createdAt = new Date(1_787_909_120_000 + enqueueSequence);
  const taskId = `runtime-task-${enqueueSequence}`;
  return {
    delivery_id: deliveryId,
    enqueue_sequence: enqueueSequence,
    target_session_id: RUNTIME_FOLLOWUP_SESSION_ID,
    source_session_id: null,
    relation_key: `claude_runtime:${RUNTIME_FOLLOWUP_SESSION_ID}:${taskId}`,
    completion_id: `completion:${deliveryId}`,
    intent: "runtime_followup",
    source: "claude_runtime_task_followup",
    producer_kind: "claude_runtime_task",
    producer_id: taskId,
    producer_terminal_revision: String(1_787_909_120_000 + enqueueSequence),
    parent_delivery_id: null,
    caller_turn_id: null,
    payload_hash: `fixture:${deliveryId}`,
    payload: {
      text: `runtime follow-up seq${enqueueSequence}`,
      user: "system",
      caller_info: null,
      attachment_paths: null,
      context: null,
      followup_task_ids: [taskId],
      followup_key: taskId,
      followup_attempt: 1,
    },
    state: "pending",
    aggregate_state: "pending",
    created_at: createdAt,
    updated_at: createdAt,
    claimed_at: null,
    dispatching_at: null,
    lease_owner: null,
    lease_expires_at: null,
    attempt_count: 0,
    next_attempt_at: createdAt,
    last_error: null,
    queued_at: null,
    delivered_at: null,
    consumed_at: null,
    superseded_at: null,
    superseded_terminal_revision: null,
    target_receipt_id: null,
    target_receipt_at: null,
    consumed_reason: null,
    dead_letter_reason: null,
    dead_lettered_at: null,
  };
}

export function runtimeFollowupCommand(row: RuntimeFollowupFixtureRow) {
  return {
    type: "intervene" as const,
    agentSessionId: RUNTIME_FOLLOWUP_SESSION_ID,
    text: row.payload.text,
    user: row.payload.user,
    delivery_id: row.delivery_id,
    delivery_intent: row.intent,
    source: row.source,
    completion_id: row.completion_id,
    relation_key: row.relation_key,
    producer_terminal_revision: row.producer_terminal_revision,
    created_at: row.created_at.toISOString(),
    delivery_lease_owner: row.lease_owner,
  };
}

export function runtimeFollowupSessionSnapshot(): Record<string, unknown> {
  return {
    agent_session_id: RUNTIME_FOLLOWUP_SESSION_ID,
    session_id: RUNTIME_FOLLOWUP_SESSION_ID,
    node_id: RUNTIME_FOLLOWUP_NODE_ID,
    nodeId: RUNTIME_FOLLOWUP_NODE_ID,
    status: "running",
    agent_id: "roselin",
    display_name: "runtime follow-up reconnect fixture",
    created_at: new Date("2026-08-28T10:00:00.000Z"),
    updated_at: new Date("2026-08-28T10:05:00.000Z"),
  };
}
