import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { CompletionDeliveryCoordinator } from
  "../../src/task/completion_delivery_coordinator.js";
import { DELIVERY_NOTIFICATION_MAX_ATTEMPTS } from
  "../../src/task/session_delivery_notification_policy.js";

describe("CompletionDeliveryCoordinator", () => {
  it("terminalizes an exhausted base delivery instead of scheduling an unbounded retry", async () => {
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
    const retryLeasedDelivery = vi.fn();
    const markUncertain = vi.fn().mockResolvedValue({
      ...claimed,
      state: "uncertain",
      lease_owner: null,
    });
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

    expect(markUncertain).toHaveBeenCalledWith(
      "delivery-exhausted",
      "completion:test-worker",
      "ledger stage failed",
    );
    expect(retryLeasedDelivery).not.toHaveBeenCalled();
  });
});
