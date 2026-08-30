import { describe, expect, it, vi } from "vitest";

import { CompletionDeliveryCoordinator } from
  "../../src/task/completion_delivery_coordinator.js";

const createdAt = new Date("2026-08-28T00:00:00.000Z");

function claimedRow(overrides: Record<string, unknown> = {}) {
  return {
    delivery_id: "delivery-completion",
    target_session_id: "caller-session",
    source_session_id: "child-session",
    relation_key: "child_session:child-session:42",
    completion_id: "completion-delivery-completion",
    intent: "completion_notification",
    source: "completion_notifier",
    producer_kind: "child_session",
    producer_id: "child-session",
    producer_terminal_revision: "42",
    parent_delivery_id: null,
    caller_turn_id: null,
    payload_hash: "hash-completion",
    payload: { text: "done", user: "agent", caller_info: { source: "agent" } },
    state: "claimed",
    aggregate_state: "pending",
    attempt_count: 0,
    next_attempt_at: createdAt,
    last_error: null,
    lease_owner: "completion:test-worker",
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
    ...overrides,
  };
}

function repositoryFixture(row = claimedRow()) {
  return {
    register: vi.fn().mockResolvedValue({
      row: { ...row, state: "pending", lease_owner: null },
      inserted: true,
      conflict: false,
    }),
    get: vi.fn().mockResolvedValue(row),
    claimRecoverableCompletionDeliveries: vi.fn().mockResolvedValue([row]),
    releaseExpiredDeliveryLeases: vi.fn().mockResolvedValue(0),
  };
}

function loggerFixture() {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
}

function input() {
  return {
    targetSessionId: "caller-session",
    sourceSessionId: "child-session",
    terminalRevision: "42",
    text: "done",
    callerInfo: { source: "agent" as const },
    createdAt,
  };
}

describe("CompletionDeliveryCoordinator", () => {
  it("uses one claim-and-dispatch path for immediate enqueue", async () => {
    const repository = repositoryFixture();
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const coordinator = new CompletionDeliveryCoordinator({
      repository: repository as never,
      dispatch,
      logger: loggerFixture(),
    }, "completion:test-worker");

    await coordinator.enqueue(input());

    expect(repository.claimRecoverableCompletionDeliveries).toHaveBeenCalledWith(
      "completion:test-worker",
      1,
      60_000,
      "delivery-completion",
    );
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("uses the same claim-and-dispatch path for recovery", async () => {
    const repository = repositoryFixture();
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const coordinator = new CompletionDeliveryCoordinator({
      repository: repository as never,
      dispatch,
      logger: loggerFixture(),
    }, "completion:test-worker");

    await coordinator.recoverPending(7);

    expect(repository.releaseExpiredDeliveryLeases).toHaveBeenCalledOnce();
    expect(repository.claimRecoverableCompletionDeliveries).toHaveBeenCalledWith(
      "completion:test-worker",
      7,
      60_000,
      undefined,
    );
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("keeps the exact claim intact when dispatch cannot prove acceptance", async () => {
    const repository = repositoryFixture();
    const dispatch = vi.fn().mockRejectedValue(new Error("dispatch timed out"));
    const logger = loggerFixture();
    const coordinator = new CompletionDeliveryCoordinator({
      repository: repository as never,
      dispatch,
      logger,
    }, "completion:test-worker");

    await coordinator.enqueue(input());

    expect(repository.get).toHaveBeenCalledWith("delivery-completion");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: "delivery-completion" }),
      "Completion dispatch did not prove acceptance; claim remains for lease recovery",
    );
  });

  it("quarantines a self-completion identity without consuming it", async () => {
    const repository = repositoryFixture(claimedRow({
      target_session_id: "child-session",
      source_session_id: "child-session",
    }));
    const dispatch = vi.fn();
    const logger = loggerFixture();
    const coordinator = new CompletionDeliveryCoordinator({
      repository: repository as never,
      dispatch,
      logger,
    }, "completion:test-worker");

    await coordinator.enqueue({ ...input(), targetSessionId: "child-session" });

    expect(dispatch).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: "delivery-completion" }),
      "Self completion identity quarantined without consuming its delivery",
    );
  });
});
