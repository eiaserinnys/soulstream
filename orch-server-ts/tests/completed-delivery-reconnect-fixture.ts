export const LIVE_COMPLETED_SESSION_ID = "435e0aea-dc41-4909-b4a1-d3b735d0b8e6";
export const LIVE_COMPLETED_NODE_ID = "fake-node";
export const LIVE_COMPLETED_DELIVERY_IDS = [
  "f8a08628-c577-4a9a-89c7-a2a585f958b9",
  "e7d85cda-d77c-4056-8e00-0704083a0290",
] as const;

export interface CompletedDeliveryReconnectScenario {
  label:
    | "completed-connected"
    | "completed-disconnected-reconnect"
    | "completed-two-input-coalesce"
    | "active-generation-control";
  initiallyConnected: boolean;
  reconnect: boolean;
  targetStatus: "completed" | "running";
  deliveryIds: readonly string[];
  expectedNewGenerations: number;
}

export const COMPLETED_DELIVERY_RECONNECT_MATRIX:
readonly CompletedDeliveryReconnectScenario[] = [
  {
    label: "completed-connected",
    initiallyConnected: true,
    reconnect: false,
    targetStatus: "completed",
    deliveryIds: ["435e0000-0000-4000-8000-000000000001"],
    expectedNewGenerations: 1,
  },
  {
    label: "completed-disconnected-reconnect",
    initiallyConnected: false,
    reconnect: true,
    targetStatus: "completed",
    deliveryIds: [LIVE_COMPLETED_DELIVERY_IDS[0]],
    expectedNewGenerations: 1,
  },
  {
    label: "completed-two-input-coalesce",
    initiallyConnected: false,
    reconnect: true,
    targetStatus: "completed",
    deliveryIds: LIVE_COMPLETED_DELIVERY_IDS,
    expectedNewGenerations: 1,
  },
  {
    label: "active-generation-control",
    initiallyConnected: true,
    reconnect: false,
    targetStatus: "running",
    deliveryIds: ["435e0000-0000-4000-8000-000000000004"],
    expectedNewGenerations: 0,
  },
];

export interface DeliveryLedgerRow {
  delivery_id: string;
  target_session_id: string;
  source_session_id: string | null;
  relation_key: string;
  completion_id: string;
  intent: string;
  source: string;
  producer_kind: string | null;
  producer_id: string | null;
  producer_terminal_revision: string | null;
  parent_delivery_id: string | null;
  caller_turn_id: string | null;
  payload_hash: string;
  payload: Record<string, unknown>;
  state: string;
  aggregate_state: string;
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

export function completedSessionRow(
  status: "completed" | "running",
): Record<string, unknown> {
  const terminal = status === "completed";
  return {
    session_id: LIVE_COMPLETED_SESSION_ID,
    folder_id: "folder-linegames",
    display_name: "live completed delivery reconnect fixture",
    node_id: LIVE_COMPLETED_NODE_ID,
    session_type: "claude",
    status,
    prompt: "completed prompt",
    client_id: "dashboard",
    claude_session_id: "claude-thread-completed",
    last_message: null,
    metadata: null,
    was_running_at_shutdown: false,
    last_event_id: 308,
    last_read_event_id: 308,
    created_at: new Date("2026-08-28T03:17:41.000Z"),
    updated_at: new Date("2026-08-28T03:25:56.165Z"),
    agent_id: "seosoyoung",
    caller_session_id: null,
    away_summary: null,
    termination_reason: terminal ? "completed_ok" : null,
    termination_detail: null,
    termination_event_id: terminal ? 308 : null,
    last_assistant_text: terminal ? "normal completion" : null,
    execution_generation: terminal ? "2" : "3",
    execution_manifest_id: null,
    execution_runtime_env_identity: null,
    execution_registration_id: null,
    execution_pid: null,
    execution_start_identity: null,
    execution_command_id: null,
    execution_lease_expires_at: null,
  };
}

export function interventionBody(deliveryId: string): Record<string, unknown> {
  return {
    text: `live reconnect input ${deliveryId}`,
    user: "dashboard",
    delivery_id: deliveryId,
    delivery_intent: "human_live_steer",
    source: "user_message",
    completion_id: `message:${deliveryId}`,
    relation_key: `user_message:${LIVE_COMPLETED_SESSION_ID}:${deliveryId}`,
    created_at: "2026-08-28T03:28:44.000Z",
  };
}

export function interventionCommand(deliveryId: string): Record<string, unknown> {
  return {
    type: "intervene",
    agentSessionId: LIVE_COMPLETED_SESSION_ID,
    ...interventionBody(deliveryId),
  };
}

export function makeDeliveryRow(params: Record<string, unknown>): DeliveryLedgerRow {
  const deliveryId = String(params.deliveryId);
  const createdAt = params.createdAt instanceof Date
    ? params.createdAt
    : new Date("2026-08-28T03:28:44.000Z");
  return {
    delivery_id: deliveryId,
    target_session_id: String(params.targetSessionId),
    source_session_id: null,
    relation_key: String(params.relationKey),
    completion_id: String(params.completionId),
    intent: String(params.intent),
    source: String(params.source),
    producer_kind: null,
    producer_id: null,
    producer_terminal_revision: null,
    parent_delivery_id: null,
    caller_turn_id: null,
    payload_hash: String(params.payloadHash),
    payload: params.payload as Record<string, unknown>,
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
