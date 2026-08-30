import { describe, expect, it, vi } from "vitest";

import { TaskDeliveryLedgerGate } from "../../src/task/task_delivery_ledger_gate.js";

const createdAt = new Date("2026-08-30T00:00:00.000Z");
const row = {
  delivery_id: "delivery-1",
  target_session_id: "parent-1",
  source_session_id: "child-1",
  relation_key: "child_session:child-1:42",
  completion_id: "completion-1",
  intent: "completion_notification",
  source: "completion_notifier",
  producer_kind: "child_session",
  producer_id: "child-1",
  producer_terminal_revision: "42",
  parent_delivery_id: null,
  caller_turn_id: null,
  payload_hash: "hash-1",
  payload: { text: "done", user: "agent", source: "completion_notifier" },
  state: "claimed",
  aggregate_state: "pending",
  attempt_count: 0,
  next_attempt_at: createdAt,
  last_error: null,
  lease_owner: "worker-1",
  lease_expires_at: new Date(createdAt.getTime() + 60_000),
  created_at: createdAt,
  updated_at: createdAt,
  claimed_at: createdAt,
  dispatching_at: null,
  queued_at: null,
  delivered_at: null,
  consumed_at: null,
  superseded_at: null,
  superseded_terminal_revision: null,
};

function repositoryFixture() {
  return {
    register: vi.fn().mockResolvedValue({ row, inserted: false, conflict: false }),
    claimForTarget: vi.fn(),
    beginDispatch: vi.fn().mockResolvedValue({ ...row, state: "dispatching" }),
    get: vi.fn().mockResolvedValue(row),
    markQueued: vi.fn(),
    retryLeasedDelivery: vi.fn(),
    markConsumedByRelation: vi.fn().mockResolvedValue({
      relation: {
        relation_key: row.relation_key,
        completion_id: row.completion_id,
        caller_session_id: "parent-1",
        consumed_turn_id: "event:99",
        consumed_at: createdAt,
      },
      relationInserted: true,
      deliveryConsumed: true,
    }),
    notifications: {
      stageWithQueuedDelivery: vi.fn(),
      get: vi.fn(),
      markPublished: vi.fn(),
      retry: vi.fn(),
    },
  };
}

const params = {
  agentSessionId: "parent-1",
  text: "done",
  user: "agent",
  source: "completion_notifier",
  deliveryId: row.delivery_id,
  deliveryIntent: "completion_notification" as const,
  completionId: row.completion_id,
  relationKey: row.relation_key,
  deliveryLeaseOwner: row.lease_owner!,
  storedDeliveryPayload: row.payload,
  storedDeliveryPayloadHash: row.payload_hash,
};

describe("TaskDeliveryLedgerGate", () => {
  it("admits the exact claimed delivery lease", async () => {
    const repository = repositoryFixture();
    const gate = new TaskDeliveryLedgerGate(true, repository as never);

    await expect(gate.admit(params)).resolves.toMatchObject({
      kind: "admitted",
      deliveryId: row.delivery_id,
    });
  });

  it("records relation receipt and consumed projection through one exact call", async () => {
    const repository = repositoryFixture();
    const gate = new TaskDeliveryLedgerGate(true, repository as never);
    const task = {
      agentSessionId: "parent-1",
      lastEventId: 99,
      interventionQueue: [],
    };

    await gate.recordConsumed(params, task as never);

    expect(repository.markConsumedByRelation).toHaveBeenCalledOnce();
    expect(repository.markConsumedByRelation).toHaveBeenCalledWith({
      deliveryId: row.delivery_id,
      relationKey: row.relation_key,
      completionId: row.completion_id,
      callerSessionId: "parent-1",
      consumedTurnId: "event:99",
    });
  });

  it("does not terminalize an ambiguous dispatch result", async () => {
    const repository = repositoryFixture();
    const gate = new TaskDeliveryLedgerGate(true, repository as never);
    const admission = { kind: "admitted" as const, deliveryId: row.delivery_id, row };

    await gate.recordResult(admission, {
      delivered: null,
      consumeWhen: "unknown",
      reason: "transport_timeout",
    } as never);

    expect(repository.retryLeasedDelivery).not.toHaveBeenCalled();
    expect(repository.markConsumedByRelation).not.toHaveBeenCalled();
  });

  it("keeps notification failure retry scheduling nonterminal", async () => {
    const repository = repositoryFixture();
    const gate = new TaskDeliveryLedgerGate(true, repository as never);
    const admission = { kind: "admitted" as const, deliveryId: row.delivery_id, row };

    await gate.recordNotificationFailure(admission, "publish failed");

    expect(repository.notifications.retry).toHaveBeenCalledWith(
      row.delivery_id,
      row.lease_owner,
      "publish failed",
      expect.any(Date),
    );
  });
});
