import { vi } from "vitest";

import type { CompletedResumeDeliveryObservation } from
  "./completed-resume-ingress-oracle.js";

export const COMPLETED_SESSION_ID = "435e0aea-dc41-4909-b4a1-d3b735d0b8e6";
export const COMPLETED_NODE_ID = "fake-node";

export interface CompletedResumeScenario {
  label: string;
  clicks?: number;
  deliveryIds?: readonly string[];
  memoryResident: boolean;
  executionDrainBarrier: boolean;
  lastEventId: number;
  terminalEventId: number;
  historicalGeneration: number | null;
}

interface CompletedResumeDeliveryRow {
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

export class InMemoryDeliveryLedger {
  private readonly store = new Map<string, CompletedResumeDeliveryRow>();
  registerCalls = 0;
  getCalls = 0;
  claimCalls = 0;
  beginCalls = 0;

  rows(): CompletedResumeDeliveryRow[] {
    return [...this.store.values()].map((row) => structuredClone(row));
  }

  async register(params: Record<string, unknown>) {
    this.registerCalls += 1;
    const deliveryId = String(params.deliveryId);
    const existing = this.store.get(deliveryId);
    if (existing) {
      return { row: structuredClone(existing), inserted: false, conflict: false };
    }
    const createdAt = params.createdAt instanceof Date ? params.createdAt : new Date();
    const row: CompletedResumeDeliveryRow = {
      delivery_id: deliveryId,
      target_session_id: String(params.targetSessionId),
      source_session_id: null,
      relation_key: String(params.relationKey),
      completion_id: String(params.completionId),
      intent: "human_live_steer",
      source: String(params.source ?? "user_message"),
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
    this.store.set(deliveryId, row);
    return { row: structuredClone(row), inserted: true, conflict: false };
  }

  async get(deliveryId: string) {
    this.getCalls += 1;
    const row = this.store.get(deliveryId);
    return row ? structuredClone(row) : null;
  }

  async claimForTarget(deliveryId: string, targetSessionId: string, leaseOwner: string) {
    this.claimCalls += 1;
    const row = this.store.get(deliveryId);
    if (!row || row.state !== "pending") return null;
    const claimed = structuredClone(row);
    claimed.state = "claimed";
    claimed.target_session_id = targetSessionId;
    claimed.claimed_at = new Date();
    claimed.lease_owner = leaseOwner;
    claimed.lease_expires_at = new Date(Date.now() + 30_000);
    this.store.set(deliveryId, claimed);
    return structuredClone(claimed);
  }

  async beginDispatch(deliveryId: string, leaseOwner?: string) {
    this.beginCalls += 1;
    const row = this.store.get(deliveryId);
    if (!row || row.lease_owner !== leaseOwner) return null;
    const dispatching = structuredClone(row);
    dispatching.state = "dispatching";
    dispatching.dispatching_at = new Date();
    this.store.set(deliveryId, dispatching);
    return structuredClone(dispatching);
  }

  async markQueued(deliveryId: string, leaseOwner: string) {
    const row = this.store.get(deliveryId);
    if (!row || row.lease_owner !== leaseOwner) return null;
    const queued = structuredClone(row);
    queued.state = "queued";
    queued.queued_at = new Date();
    queued.lease_owner = null;
    queued.lease_expires_at = null;
    this.store.set(deliveryId, queued);
    return structuredClone(queued);
  }

  async markDelivered() { return null; }
  async markUncertain() { return null; }
  async markConsumed() { return null; }
  async markConsumedByRelation() { return null; }
  async recordRelationConsumed() { return null; }
  async retryLeasedDelivery() { return null; }
  async releaseExpiredDeliveryLeases() { return 0; }
  async claimQueuedAfterNodeRestart(_nodeId: string, leaseOwner: string) {
    return this.rows().filter((row) => row.state === "queued").map((row) => {
      const dispatching = structuredClone(row);
      dispatching.state = "dispatching";
      dispatching.lease_owner = leaseOwner;
      dispatching.lease_expires_at = new Date(Date.now() + 60_000);
      this.store.set(dispatching.delivery_id, dispatching);
      return structuredClone(dispatching);
    });
  }
  async markDeliveredFromTranscript() { return null; }
  async deferQueuedTranscriptCheck(
    deliveryId: string,
    leaseOwner: string,
    reason: string,
  ) {
    const row = this.store.get(deliveryId);
    if (!row || row.lease_owner !== leaseOwner) return null;
    const queued = structuredClone(row);
    queued.state = "queued";
    queued.lease_owner = null;
    queued.lease_expires_at = null;
    queued.last_error = reason;
    this.store.set(deliveryId, queued);
    return structuredClone(queued);
  }
  async markPendingSuperseded() { return null; }
  notifications = {
    stageWithQueuedDelivery: vi.fn(),
    get: vi.fn(),
    markPublished: vi.fn(),
    retry: vi.fn(),
  };
}

export function completedSessionRow(scenario: CompletedResumeScenario) {
  return {
    session_id: COMPLETED_SESSION_ID,
    folder_id: "folder-linegames",
    display_name: "completed resume fixture",
    node_id: COMPLETED_NODE_ID,
    session_type: "claude",
    status: "completed",
    prompt: "completed prompt",
    client_id: "dashboard",
    claude_session_id: "claude-thread-completed",
    last_message: null,
    metadata: null,
    was_running_at_shutdown: false,
    last_event_id: scenario.lastEventId,
    last_read_event_id: scenario.lastEventId,
    created_at: new Date("2026-08-28T03:17:41.000Z"),
    updated_at: new Date("2026-08-28T03:25:56.165Z"),
    agent_id: "seosoyoung",
    caller_session_id: null,
    away_summary: null,
    termination_reason: "completed_ok",
    termination_detail: null,
    termination_event_id: scenario.terminalEventId,
    last_assistant_text: "normal completion",
    execution_generation: scenario.historicalGeneration,
    execution_manifest_id: null,
    execution_runtime_env_identity: null,
    execution_registration_id: null,
    execution_pid: null,
    execution_start_identity: null,
    execution_command_id: null,
    execution_lease_expires_at: null,
  };
}

export function observeCompletedDelivery(
  row: CompletedResumeDeliveryRow,
): CompletedResumeDeliveryObservation {
  return {
    deliveryId: row.delivery_id,
    state: row.state,
    aggregateState: row.aggregate_state,
    attemptCount: row.attempt_count,
    dispatching: row.dispatching_at !== null,
    queued: row.queued_at !== null,
    delivered: row.delivered_at !== null,
    consumed: row.consumed_at !== null,
    lastError: row.last_error,
  };
}
