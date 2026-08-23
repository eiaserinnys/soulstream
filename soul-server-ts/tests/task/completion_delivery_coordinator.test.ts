import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { CompletionDeliveryCoordinator } from
  "../../src/task/completion_delivery_coordinator.js";
import { DELIVERY_NOTIFICATION_MAX_ATTEMPTS } from
  "../../src/task/session_delivery_notification_policy.js";

describe("CompletionDeliveryCoordinator", () => {
  it("recovers a runtime follow-up with canonical key and attempt intact", async () => {
    const createdAt = new Date("2026-08-18T04:10:00.000Z");
    const claimed = {
      delivery_id: "delivery-runtime-recovery",
      target_session_id: "caller-session",
      source_session_id: null,
      relation_key: "claude_runtime_fallback:caller-session:parent:3:hash",
      completion_id: "completion-runtime-recovery",
      intent: "runtime_followup",
      source: "claude_runtime_task_followup",
      producer_kind: null,
      producer_id: null,
      producer_terminal_revision: "task-1@8:fallback-3",
      parent_delivery_id: "parent-delivery",
      caller_turn_id: null,
      payload_hash: "hash-runtime",
      payload: {
        text: "read the completed task",
        user: "system",
        caller_info: { source: "system" },
        followup_key: "caller-session:task-1",
        followup_attempt: 3,
        followup_task_ids: ["task-1"],
      },
      state: "claimed",
      attempt_count: 2,
      next_attempt_at: createdAt,
      last_error: null,
      lease_owner: "completion:test-worker",
      lease_expires_at: new Date("2026-08-18T04:11:00.000Z"),
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
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const repository = {
      register: vi.fn(),
      get: vi.fn(),
      claimForTarget: vi.fn(),
      claimRecoverableCompletionDeliveries: vi.fn().mockResolvedValue([claimed]),
      deferPending: vi.fn(),
      retryLeasedDelivery: vi.fn(),
      releaseExpiredDeliveryLeases: vi.fn().mockResolvedValue(0),
      markUncertain: vi.fn(),
    };
    const coordinator = new CompletionDeliveryCoordinator({
      repository: repository as never,
      dispatch,
      logger: pino({ level: "silent" }),
    }, "completion:test-worker");

    await coordinator.recoverPending();

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      deliveryId: "delivery-runtime-recovery",
      deliveryIntent: "runtime_followup",
      followupKey: "caller-session:task-1",
      followupAttempt: 3,
      followupTaskIds: ["task-1"],
      storedDeliveryPayload: claimed.payload,
      storedDeliveryPayloadHash: "hash-runtime",
    }));
  });

  it("terminalizes a stale durable self completion during recovery without dispatching it", async () => {
    const createdAt = new Date("2026-08-17T00:00:00.000Z");
    const claimed = {
      delivery_id: "delivery-stale-self",
      target_session_id: "self-session",
      source_session_id: "self-session",
      relation_key: "child_session:self-session:8",
      completion_id: "completion-stale-self",
      intent: "completion_notification",
      source: "completion_notifier",
      producer_kind: "child_session",
      producer_id: "self-session",
      producer_terminal_revision: "8",
      parent_delivery_id: null,
      caller_turn_id: null,
      payload_hash: "hash",
      payload: {
        text: "done",
        user: "agent",
        caller_info: { source: "agent" },
      },
      state: "claimed",
      attempt_count: 1,
      next_attempt_at: createdAt,
      last_error: null,
      lease_owner: "completion:test-worker",
      lease_expires_at: new Date("2026-08-17T00:01:00.000Z"),
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
    const dispatch = vi.fn();
    const markUncertain = vi.fn().mockResolvedValue({
      ...claimed,
      state: "uncertain",
      lease_owner: null,
    });
    const repository = {
      register: vi.fn(),
      get: vi.fn(),
      claimForTarget: vi.fn(),
      claimRecoverableCompletionDeliveries: vi.fn().mockResolvedValue([claimed]),
      deferPending: vi.fn(),
      retryLeasedDelivery: vi.fn(),
      releaseExpiredDeliveryLeases: vi.fn().mockResolvedValue(0),
      markUncertain,
    };
    const coordinator = new CompletionDeliveryCoordinator({
      repository: repository as never,
      dispatch,
      logger: pino({ level: "silent" }),
    }, "completion:test-worker");

    await coordinator.recoverPending();

    expect(dispatch).not.toHaveBeenCalled();
    expect(markUncertain).toHaveBeenCalledWith(
      "delivery-stale-self",
      "completion:test-worker",
      "stale_self_completion_delivery",
    );
    expect(repository.retryLeasedDelivery).not.toHaveBeenCalled();
  });

  it("parks an exhausted base delivery for a later execution revival", async () => {
    const createdAt = new Date("2026-08-17T00:00:00.000Z");
    const row = {
      delivery_id: "delivery-exhausted",
      target_session_id: "caller-session",
      source_session_id: "child-session",
      relation_key: "child_session:child-session:8",
      completion_id: "completion-exhausted",
      intent: "completion_notification",
      source: "completion_notifier",
      producer_kind: "child_session",
      producer_id: "child-session",
      producer_terminal_revision: "8",
      parent_delivery_id: null,
      caller_turn_id: null,
      payload_hash: "hash",
      payload: {
        text: "done",
        user: "agent",
        caller_info: { source: "agent" },
      },
      state: "pending",
      attempt_count: DELIVERY_NOTIFICATION_MAX_ATTEMPTS - 1,
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
    };
    const claimed = {
      ...row,
      state: "claimed",
      lease_owner: "completion:test-worker",
    };
    const retryLeasedDelivery = vi.fn().mockResolvedValue({
      ...claimed,
      state: "uncertain",
      aggregate_state: "pending",
      lease_owner: null,
    });
    const markUncertain = vi.fn();
    const repository = {
      register: vi.fn().mockResolvedValue({ row, inserted: true, conflict: false }),
      get: vi.fn().mockResolvedValue(row),
      claimForTarget: vi.fn().mockResolvedValue(claimed),
      claimRecoverableCompletionDeliveries: vi.fn().mockResolvedValue([]),
      deferPending: vi.fn(),
      retryLeasedDelivery,
      releaseExpiredDeliveryLeases: vi.fn().mockResolvedValue(0),
      markUncertain,
    };
    const coordinator = new CompletionDeliveryCoordinator({
      repository: repository as never,
      dispatch: vi.fn().mockRejectedValue(new Error("ledger stage failed")),
      logger: pino({ level: "silent" }),
    }, "completion:test-worker");

    await coordinator.enqueue({
      targetSessionId: "caller-session",
      sourceSessionId: "child-session",
      terminalRevision: "8",
      text: "done",
      callerInfo: { source: "agent" },
      createdAt,
    });

    expect(retryLeasedDelivery).toHaveBeenCalledWith(
      "delivery-exhausted",
      "completion:test-worker",
      "ledger stage failed",
      expect.any(Number),
    );
    expect(markUncertain).not.toHaveBeenCalled();
  });

  it("does not retry after an ambiguous dispatch already reached queued", async () => {
    const createdAt = new Date();
    const claimed = {
      delivery_id: "delivery-accepted-before-timeout",
      target_session_id: "caller-session",
      source_session_id: "child-session",
      relation_key: "child_session:child-session:accepted",
      completion_id: "completion-accepted",
      intent: "completion_notification",
      source: "completion_notifier",
      producer_kind: "child_session",
      producer_id: "child-session",
      producer_terminal_revision: "accepted",
      parent_delivery_id: null,
      caller_turn_id: null,
      payload_hash: "hash",
      payload: { text: "done", user: "agent" },
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
    };
    const repository = {
      register: vi.fn(),
      get: vi.fn().mockResolvedValue({ ...claimed, state: "queued" }),
      claimForTarget: vi.fn(),
      claimRecoverableCompletionDeliveries: vi.fn().mockResolvedValue([claimed]),
      deferPending: vi.fn(),
      retryLeasedDelivery: vi.fn(),
      releaseExpiredDeliveryLeases: vi.fn().mockResolvedValue(0),
      markUncertain: vi.fn(),
    };
    const info = vi.fn();
    const coordinator = new CompletionDeliveryCoordinator({
      repository: repository as never,
      dispatch: vi.fn().mockRejectedValue(new Error("503 after durable queue")),
      logger: { error: vi.fn(), warn: vi.fn(), info } as never,
    }, "completion:test-worker");

    await coordinator.recoverPending();

    expect(repository.retryLeasedDelivery).not.toHaveBeenCalled();
    expect(repository.markUncertain).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: "delivery-accepted-before-timeout",
        state: "queued",
      }),
      "Completion delivery dispatch returned ambiguously after durable acceptance",
    );
  });

  it("does not report a retry as scheduled after losing the delivery lease", async () => {
    const createdAt = new Date();
    const claimed = {
      delivery_id: "delivery-lease-lost",
      target_session_id: "caller-session",
      source_session_id: "child-session",
      relation_key: "child_session:child-session:9",
      completion_id: "completion-lease-lost",
      intent: "completion_notification",
      source: "completion_notifier",
      producer_kind: "child_session",
      producer_id: "child-session",
      producer_terminal_revision: "9",
      parent_delivery_id: null,
      caller_turn_id: null,
      payload_hash: "hash",
      payload: { text: "done", user: "agent" },
      state: "claimed",
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
    };
    const warn = vi.fn();
    const repository = {
      register: vi.fn(),
      get: vi.fn(),
      claimForTarget: vi.fn(),
      claimRecoverableCompletionDeliveries: vi.fn().mockResolvedValue([claimed]),
      deferPending: vi.fn(),
      retryLeasedDelivery: vi.fn().mockResolvedValue(null),
      releaseExpiredDeliveryLeases: vi.fn().mockResolvedValue(0),
      markUncertain: vi.fn(),
    };
    const coordinator = new CompletionDeliveryCoordinator({
      repository: repository as never,
      dispatch: vi.fn().mockRejectedValue(new Error("dispatch failed")),
      logger: { error: vi.fn(), warn, info: vi.fn() } as never,
    }, "completion:test-worker");

    await coordinator.recoverPending();

    expect(repository.retryLeasedDelivery).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: "delivery-lease-lost" }),
      "Completion delivery retry not scheduled because the dispatch lease was lost",
    );
    expect(warn).not.toHaveBeenCalledWith(
      expect.anything(),
      "Completion delivery dispatch failed; durable retry scheduled",
    );
  });
  /**
   * One claim covers the whole batch, so bounding a single dispatch is not
   * enough: without a batch budget a long run of slow dispatches outlives the
   * lease and the sweeper returns rows to `pending` underneath their owner.
   */
  it("stops dispatching once too little lease remains for another row", async () => {
    const at = new Date("2026-08-20T00:00:00.000Z");
    const rows = [1, 2, 3, 4].map((index) => ({
      delivery_id: `delivery-batch-${index}`,
      target_session_id: "caller-session",
      source_session_id: "child-session",
      relation_key: `child_session:child-session:${index}`,
      completion_id: `completion-batch-${index}`,
      intent: "completion_notification",
      source: "completion_notifier",
      producer_kind: "child_session",
      producer_id: "child-session",
      producer_terminal_revision: `${index}`,
      parent_delivery_id: null,
      caller_turn_id: null,
      payload_hash: "hash",
      payload: { text: "done", user: "agent", caller_info: { source: "agent" } },
      state: "claimed",
      attempt_count: 0,
      next_attempt_at: at,
      last_error: null,
      lease_owner: "worker-batch",
      lease_expires_at: at,
      created_at: at,
      updated_at: at,
      claimed_at: at,
      dispatching_at: null,
      queued_at: null,
      delivered_at: null,
      consumed_at: null,
      superseded_at: null,
      superseded_terminal_revision: null,
    }));
    const dispatch = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const repository = {
      register: vi.fn(),
      get: vi.fn(),
      claimForTarget: vi.fn(),
      claimRecoverableCompletionDeliveries: vi.fn().mockResolvedValue(rows),
      deferPending: vi.fn(),
      retryLeasedDelivery: vi.fn(),
      releaseExpiredDeliveryLeases: vi.fn().mockResolvedValue(0),
      markUncertain: vi.fn(),
    };
    const coordinator = new CompletionDeliveryCoordinator(
      { repository, dispatch, logger },
      "worker-batch",
      60,
      1_800_000,
      20,
    );

    await coordinator.recoverPending();

    expect(dispatch.mock.calls.length).toBeLessThan(rows.length);
    expect(logger.warn.mock.calls.some(([, message]) =>
      String(message).includes("ran out of lease")
    )).toBe(true);
  });

});
