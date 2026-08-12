import { describe, expect, it, vi } from "vitest";

import type { SessionDeliveryNotificationOutboxRow } from "../../src/db/session_db_types.js";
import { SessionDeliveryNotificationRecovery } from "../../src/task/session_delivery_notification_recovery.js";
import type { Task } from "../../src/task/task_models.js";

function row(
  deliveryId: string,
  targetSessionId: string,
): SessionDeliveryNotificationOutboxRow {
  const now = new Date("2026-07-26T00:00:00Z");
  return {
    delivery_id: deliveryId,
    target_session_id: targetSessionId,
    payload: {
      text: "done",
      user: "agent",
      source: "completion_notifier",
      delivery_intent: "completion_notification",
      completion_id: `completion-${deliveryId}`,
      relation_key: `relation-${deliveryId}`,
    },
    disposition: "queued",
    state: "claimed",
    lease_owner: "notification-worker",
    lease_expires_at: new Date("2026-07-26T00:01:00Z"),
    attempt_count: 0,
    next_attempt_at: now,
    last_error: null,
    created_at: now,
    updated_at: now,
    published_at: null,
    dead_lettered_at: null,
  };
}

function task(sessionId: string): Task {
  return {
    agentSessionId: sessionId,
    prompt: "",
    status: "completed",
    createdAt: new Date(),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
  };
}

describe("SessionDeliveryNotificationRecovery", () => {
  it("dead-letters a non-retryable notification without starving the next delivery", async () => {
    const poison = row("delivery-poison", "missing-target");
    const healthy = row("delivery-healthy", "healthy-target");
    const repository = {
      releaseExpiredLeases: vi.fn().mockResolvedValue(0),
      claimDue: vi.fn().mockResolvedValue([poison, healthy]),
      markPublished: vi.fn().mockResolvedValue(healthy),
      retry: vi.fn().mockResolvedValue(poison),
      deadLetter: vi.fn().mockResolvedValue({ ...poison, state: "dead_letter" }),
    };
    const publish = vi.fn().mockResolvedValue(true);
    const recovery = new SessionDeliveryNotificationRecovery({
      repository,
      targetNodeId: "node-test",
      resolveTask: vi.fn(async (sessionId) => {
        if (sessionId === "missing-target") return null;
        return task(sessionId);
      }),
      publish,
      logger: { warn: vi.fn() },
    });

    await expect(recovery.recover("notification-worker", 100)).resolves.toBe(2);

    expect(repository.deadLetter).toHaveBeenCalledWith(
      "delivery-poison",
      "notification-worker",
      "Notification target session not found: missing-target",
    );
    expect(repository.retry).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(repository.markPublished).toHaveBeenCalledWith(
      "delivery-healthy",
      "notification-worker",
    );
  });

  it("keeps a failed persistence attempt retryable", async () => {
    const pending = row("delivery-persist-failure", "target");
    const repository = {
      releaseExpiredLeases: vi.fn().mockResolvedValue(0),
      claimDue: vi.fn().mockResolvedValue([pending]),
      markPublished: vi.fn(),
      retry: vi.fn().mockResolvedValue(pending),
      deadLetter: vi.fn(),
    };
    const recovery = new SessionDeliveryNotificationRecovery({
      repository,
      targetNodeId: "node-test",
      resolveTask: vi.fn().mockResolvedValue(task("target")),
      publish: vi.fn().mockResolvedValue(false),
      logger: { warn: vi.fn() },
    });

    await recovery.recover("notification-worker");

    expect(repository.markPublished).not.toHaveBeenCalled();
    expect(repository.retry).toHaveBeenCalledWith(
      pending.delivery_id,
      "notification-worker",
      "session_notification persistence failed",
      expect.any(Date),
      16,
      expect.any(Date),
    );
    expect(repository.deadLetter).not.toHaveBeenCalled();
  });

  it("decodes a legacy camelCase deliveryIntent during rolling migration", async () => {
    const legacy = row("delivery-legacy", "target");
    legacy.payload = {
      ...legacy.payload,
      delivery_intent: undefined,
      deliveryIntent: "completion_notification",
    };
    const repository = {
      releaseExpiredLeases: vi.fn().mockResolvedValue(0),
      claimDue: vi.fn().mockResolvedValue([legacy]),
      markPublished: vi.fn().mockResolvedValue(legacy),
      retry: vi.fn(),
      deadLetter: vi.fn(),
    };
    const publish = vi.fn().mockResolvedValue(true);
    const recovery = new SessionDeliveryNotificationRecovery({
      repository,
      targetNodeId: "node-test",
      resolveTask: vi.fn().mockResolvedValue(task("target")),
      publish,
      logger: { warn: vi.fn() },
    });

    await recovery.recover("notification-worker");

    expect(publish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ deliveryIntent: "completion_notification" }),
      "queued",
    );
    expect(repository.markPublished).toHaveBeenCalledOnce();
  });

  it("dead-letters an invalid decoded payload immediately without retry", async () => {
    const invalid = row("delivery-invalid", "target");
    invalid.payload = { ...invalid.payload, delivery_intent: "unknown" };
    const repository = {
      releaseExpiredLeases: vi.fn().mockResolvedValue(0),
      claimDue: vi.fn().mockResolvedValue([invalid]),
      markPublished: vi.fn(),
      retry: vi.fn(),
      deadLetter: vi.fn().mockResolvedValue({ ...invalid, state: "dead_letter" }),
    };
    const recovery = new SessionDeliveryNotificationRecovery({
      repository,
      targetNodeId: "node-test",
      resolveTask: vi.fn().mockResolvedValue(task("target")),
      publish: vi.fn(),
      logger: { warn: vi.fn() },
    });

    await recovery.recover("notification-worker");

    expect(repository.deadLetter).toHaveBeenCalledWith(
      "delivery-invalid",
      "notification-worker",
      "Unsupported outbox delivery intent: unknown",
    );
    expect(repository.retry).not.toHaveBeenCalled();
  });

  it("passes node ownership and retry ceilings to the repository", async () => {
    const repository = {
      releaseExpiredLeases: vi.fn().mockResolvedValue(0),
      claimDue: vi.fn().mockResolvedValue([]),
      markPublished: vi.fn(),
      retry: vi.fn(),
      deadLetter: vi.fn(),
    };
    const recovery = new SessionDeliveryNotificationRecovery({
      repository,
      targetNodeId: "node-test",
      resolveTask: vi.fn(),
      publish: vi.fn(),
      logger: { warn: vi.fn() },
    });

    await recovery.recover("notification-worker", 25);

    expect(repository.releaseExpiredLeases).toHaveBeenCalledWith(16, expect.any(Date));
    expect(repository.claimDue).toHaveBeenCalledWith(
      "node-test",
      "notification-worker",
      25,
    );
  });
});
