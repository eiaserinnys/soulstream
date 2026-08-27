import { describe, expect, it, vi } from "vitest";

import { CompletionDeliveryCoordinator } from
  "../../src/task/completion_delivery_coordinator.js";
import { DELIVERY_NOTIFICATION_MAX_ATTEMPTS } from
  "../../src/task/session_delivery_notification_policy.js";

const createdAt = new Date("2026-08-28T00:00:00.000Z");

function pendingRow(overrides: Record<string, unknown> = {}) {
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
    state: "pending",
    aggregate_state: "pending",
    attempt_count: 0,
    next_attempt_at: createdAt,
    last_error: null,
    lease_owner: null,
    lease_expires_at: null,
    created_at: createdAt,
    updated_at: createdAt,
    claimed_at: null,
    dispatching_at: null,
    queued_at: null,
    delivered_at: null,
    consumed_at: null,
    superseded_at: null,
    superseded_terminal_revision: null,
    ...overrides,
  };
}

function repositoryFixture(row = pendingRow()) {
  const claimed = {
    ...row,
    state: "claimed",
    lease_owner: "completion:test-worker",
    lease_expires_at: new Date(createdAt.getTime() + 60_000),
  };
  return {
    register: vi.fn().mockResolvedValue({ row, inserted: true, conflict: false }),
    get: vi.fn().mockResolvedValue(row),
    claimForTarget: vi.fn().mockResolvedValue(claimed),
    claimRecoverableCompletionDeliveries: vi.fn().mockResolvedValue([claimed]),
    deferPending: vi.fn(),
    retryLeasedDelivery: vi.fn().mockResolvedValue({
      ...claimed,
      state: "pending",
      lease_owner: null,
    }),
    releaseExpiredDeliveryLeases: vi.fn().mockResolvedValue(0),
    markUncertain: vi.fn().mockResolvedValue({
      ...claimed,
      state: "uncertain",
      lease_owner: null,
    }),
  };
}

function loggerFixture() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  };
}

describe("CompletionDeliveryCoordinator", () => {
  it("periodic recovery only releases expired leases and never dispatches held input", async () => {
    const repository = repositoryFixture();
    const dispatch = vi.fn();
    const coordinator = new CompletionDeliveryCoordinator({
      repository: repository as never,
      dispatch,
      logger: loggerFixture(),
    }, "completion:test-worker");

    await coordinator.recoverPending();
    await coordinator.recoverPending();

    expect(repository.releaseExpiredDeliveryLeases).toHaveBeenCalledTimes(2);
    expect(repository.claimRecoverableCompletionDeliveries).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("dispatches a newly registered completion once during its explicit enqueue", async () => {
    const repository = repositoryFixture();
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const coordinator = new CompletionDeliveryCoordinator({
      repository: repository as never,
      dispatch,
      logger: loggerFixture(),
    }, "completion:test-worker");

    await coordinator.enqueue({
      targetSessionId: "caller-session",
      sourceSessionId: "child-session",
      terminalRevision: "42",
      text: "done",
      callerInfo: { source: "agent" },
      createdAt,
    });

    expect(repository.claimForTarget).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      agentSessionId: "caller-session",
      deliveryIntent: "completion_notification",
      producerTerminalRevision: "42",
      storedDeliveryPayloadHash: "hash-completion",
    }));
  });

  it("keeps an initial retryable failure durable without periodic redispatch", async () => {
    const repository = repositoryFixture();
    const dispatch = vi.fn().mockRejectedValue(new Error("route unavailable"));
    const coordinator = new CompletionDeliveryCoordinator({
      repository: repository as never,
      dispatch,
      logger: loggerFixture(),
    }, "completion:test-worker");

    await coordinator.enqueue({
      targetSessionId: "caller-session",
      sourceSessionId: "child-session",
      terminalRevision: "42",
      text: "done",
      callerInfo: { source: "agent" },
      createdAt,
    });
    await coordinator.recoverPending();
    await coordinator.recoverPending();

    expect(dispatch).toHaveBeenCalledOnce();
    expect(repository.retryLeasedDelivery).toHaveBeenCalledOnce();
    expect(repository.claimRecoverableCompletionDeliveries).not.toHaveBeenCalled();
    expect(repository.markUncertain).not.toHaveBeenCalled();
  });

  it("does not redispatch when explicit enqueue returns ambiguously after durable queue", async () => {
    const row = pendingRow();
    const queued = pendingRow({
      state: "queued",
      queued_at: createdAt,
    });
    const repository = repositoryFixture(row);
    repository.get
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce(queued);
    const dispatch = vi.fn().mockRejectedValue(
      new Error("timeout after target durable queue"),
    );
    const logger = loggerFixture();
    const coordinator = new CompletionDeliveryCoordinator({
      repository: repository as never,
      dispatch,
      logger,
    }, "completion:test-worker");

    await coordinator.enqueue({
      targetSessionId: "caller-session",
      sourceSessionId: "child-session",
      terminalRevision: "42",
      text: "done",
      callerInfo: { source: "agent" },
      createdAt,
    });

    expect(dispatch).toHaveBeenCalledOnce();
    expect(repository.retryLeasedDelivery).not.toHaveBeenCalled();
    expect(repository.markUncertain).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: "delivery-completion",
        state: "queued",
      }),
      "Completion delivery dispatch returned ambiguously after durable acceptance",
    );
  });

  it("reports an explicit enqueue lease CAS loss without claiming a retry", async () => {
    const row = pendingRow();
    const repository = repositoryFixture(row);
    repository.get
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce(row);
    repository.retryLeasedDelivery.mockResolvedValueOnce(null);
    const dispatch = vi.fn().mockRejectedValue(new Error("dispatch failed"));
    const logger = loggerFixture();
    const coordinator = new CompletionDeliveryCoordinator({
      repository: repository as never,
      dispatch,
      logger,
    }, "completion:test-worker");

    await coordinator.enqueue({
      targetSessionId: "caller-session",
      sourceSessionId: "child-session",
      terminalRevision: "42",
      text: "done",
      callerInfo: { source: "agent" },
      createdAt,
    });

    expect(dispatch).toHaveBeenCalledOnce();
    expect(repository.retryLeasedDelivery).toHaveBeenCalledOnce();
    expect(repository.markUncertain).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: "delivery-completion" }),
      "Completion delivery retry not scheduled because the dispatch lease was lost",
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      "Completion delivery dispatch failed; durable retry scheduled",
    );
  });

  it("terminalizes an exhausted initial attempt without adding a recovery dispatch", async () => {
    const repository = repositoryFixture(pendingRow({
      attempt_count: DELIVERY_NOTIFICATION_MAX_ATTEMPTS - 1,
    }));
    const dispatch = vi.fn().mockRejectedValue(new Error("route unavailable"));
    const coordinator = new CompletionDeliveryCoordinator({
      repository: repository as never,
      dispatch,
      logger: loggerFixture(),
    }, "completion:test-worker");

    await coordinator.enqueue({
      targetSessionId: "caller-session",
      sourceSessionId: "child-session",
      terminalRevision: "42",
      text: "done",
      callerInfo: { source: "agent" },
      createdAt,
    });

    expect(repository.markUncertain).toHaveBeenCalledOnce();
    expect(repository.retryLeasedDelivery).not.toHaveBeenCalled();
  });

  it("suppresses a stale self completion during explicit enqueue", async () => {
    const repository = repositoryFixture(pendingRow({
      target_session_id: "child-session",
      source_session_id: "child-session",
    }));
    const dispatch = vi.fn();
    const coordinator = new CompletionDeliveryCoordinator({
      repository: repository as never,
      dispatch,
      logger: loggerFixture(),
    }, "completion:test-worker");

    await coordinator.enqueue({
      targetSessionId: "child-session",
      sourceSessionId: "child-session",
      terminalRevision: "42",
      text: "done",
      callerInfo: { source: "agent" },
      createdAt,
    });

    expect(repository.markUncertain).toHaveBeenCalledWith(
      "delivery-completion",
      "completion:test-worker",
      "stale_self_completion_delivery",
    );
    expect(dispatch).not.toHaveBeenCalled();
  });
});
