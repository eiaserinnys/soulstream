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
  it("backs off a poison notification without starving the next delivery", async () => {
    const poison = row("delivery-poison", "missing-target");
    const healthy = row("delivery-healthy", "healthy-target");
    const repository = {
      releaseExpiredLeases: vi.fn().mockResolvedValue(0),
      claimDue: vi.fn().mockResolvedValue([poison, healthy]),
      markPublished: vi.fn().mockResolvedValue(healthy),
      retry: vi.fn().mockResolvedValue(poison),
    };
    const publish = vi.fn().mockResolvedValue(true);
    const recovery = new SessionDeliveryNotificationRecovery({
      repository,
      resolveTask: vi.fn(async (sessionId) => {
        if (sessionId === "missing-target") throw new Error("target deleted");
        return task(sessionId);
      }),
      publish,
      logger: { warn: vi.fn() },
    });

    await expect(recovery.recover("notification-worker", 100)).resolves.toBe(2);

    expect(repository.retry).toHaveBeenCalledWith(
      "delivery-poison",
      "notification-worker",
      "target deleted",
      expect.any(Date),
    );
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
    };
    const recovery = new SessionDeliveryNotificationRecovery({
      repository,
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
    );
  });
});
