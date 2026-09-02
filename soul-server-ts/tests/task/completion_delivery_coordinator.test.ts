import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CompletionDeliveryCoordinator } from
  "../../src/task/completion_delivery_coordinator.js";
import {
  DELIVERY_NOTIFICATION_MAX_AGE_MS,
  DELIVERY_NOTIFICATION_MAX_ATTEMPTS,
} from
  "../../src/task/session_delivery_notification_policy.js";

const nowMs = new Date("2026-08-28T00:00:00.000Z").getTime();
const createdAt = new Date(nowMs - 1_000);

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
    attempt_token: null,
    attempt_expires_at: null,
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
    attempt_token: "completion:test-worker",
    attempt_expires_at: new Date(createdAt.getTime() + 60_000),
  };
  return {
    register: vi.fn().mockResolvedValue({ row, inserted: true, conflict: false }),
    get: vi.fn().mockResolvedValue(row),
    claimAttemptForTarget: vi.fn().mockResolvedValue(claimed),
    claimRecoverableCompletionDeliveries: vi.fn().mockResolvedValue([claimed]),
    deferPending: vi.fn(),
    retryDeliveryAttempt: vi.fn().mockResolvedValue({
      ...claimed,
      state: "pending",
      attempt_token: null,
    }),
    expireStaleDeliveryAttempts: vi.fn().mockResolvedValue(0),
    markUncertain: vi.fn().mockResolvedValue({
      ...claimed,
      state: "uncertain",
      attempt_token: null,
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
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(nowMs);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("periodic recovery only expires stale attempts and never dispatches held input", async () => {
    const repository = repositoryFixture();
    const dispatch = vi.fn();
    const coordinator = new CompletionDeliveryCoordinator({
      repository: repository as never,
      dispatch,
      logger: loggerFixture(),
    }, "completion:test-worker");

    await coordinator.recoverPending();
    await coordinator.recoverPending();

    expect(repository.expireStaleDeliveryAttempts).toHaveBeenCalledTimes(2);
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

    expect(repository.claimAttemptForTarget).toHaveBeenCalledOnce();
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
    expect(repository.retryDeliveryAttempt).toHaveBeenCalledOnce();
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
    expect(repository.retryDeliveryAttempt).not.toHaveBeenCalled();
    expect(repository.markUncertain).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: "delivery-completion",
        state: "queued",
      }),
      "Completion delivery dispatch returned ambiguously after durable acceptance",
    );
  });

  it("reports an explicit enqueue attempt CAS loss without claiming a retry", async () => {
    const row = pendingRow();
    const repository = repositoryFixture(row);
    repository.get
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce(row);
    repository.retryDeliveryAttempt.mockResolvedValueOnce(null);
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
    expect(repository.retryDeliveryAttempt).toHaveBeenCalledOnce();
    expect(repository.markUncertain).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: "delivery-completion" }),
      "Completion delivery retry not scheduled because the attempt token was lost",
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
    expect(repository.retryDeliveryAttempt).not.toHaveBeenCalled();
  });

  it("retries a failed delivery immediately before the 24-hour age limit", async () => {
    const boundaryCreatedAt = new Date(nowMs - DELIVERY_NOTIFICATION_MAX_AGE_MS + 1);
    const repository = repositoryFixture(pendingRow({
      created_at: boundaryCreatedAt,
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
      createdAt: boundaryCreatedAt,
    });

    expect(repository.retryDeliveryAttempt).toHaveBeenCalledOnce();
    expect(repository.markUncertain).not.toHaveBeenCalled();
  });

  it("terminalizes a failed delivery immediately after the 24-hour age limit", async () => {
    const boundaryCreatedAt = new Date(nowMs - DELIVERY_NOTIFICATION_MAX_AGE_MS - 1);
    const repository = repositoryFixture(pendingRow({
      created_at: boundaryCreatedAt,
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
      createdAt: boundaryCreatedAt,
    });

    expect(repository.markUncertain).toHaveBeenCalledOnce();
    expect(repository.retryDeliveryAttempt).not.toHaveBeenCalled();
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
