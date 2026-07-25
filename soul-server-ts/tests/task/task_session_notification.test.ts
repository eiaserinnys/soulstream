import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { SessionNotificationPublisher } from "../../src/task/task_session_notification.js";
import type { InterventionMessage, Task } from "../../src/task/task_models.js";

function makeTask(): Task {
  return {
    agentSessionId: "caller-1",
    prompt: "original",
    status: "running",
    createdAt: new Date("2026-07-26T00:00:00Z"),
    lastEventId: 40,
    lastReadEventId: 10,
    interventionQueue: [],
  };
}

function makeMessage(): InterventionMessage {
  return {
    text: "child completed",
    user: "agent",
    deliveryId: "99999999-9999-4999-8999-999999999999",
    deliveryIntent: "completion_notification",
    completionId: "completion-1",
    relationKey: "child_session:child-1:42",
    source: "completion_notifier",
  };
}

function makeSubject(inserted: boolean) {
  const persistence = {
    persistEventWithResult: vi.fn().mockResolvedValue({
      eventId: 41,
      inserted,
    }),
    handleSideEffects: vi.fn().mockResolvedValue(undefined),
  };
  const broadcaster = {
    emitEventEnvelope: vi.fn().mockResolvedValue(undefined),
  };
  const publisher = new SessionNotificationPublisher({
    persistence: persistence as never,
    broadcaster: broadcaster as never,
    logger: { warn: vi.fn() } as unknown as Logger,
  });
  return { publisher, persistence, broadcaster };
}

describe("SessionNotificationPublisher", () => {
  it("persists and broadcasts the first canonical completion notification", async () => {
    const { publisher, persistence, broadcaster } = makeSubject(true);
    const task = makeTask();

    await publisher.publish(task, makeMessage(), "queued");

    expect(persistence.persistEventWithResult).toHaveBeenCalledWith(
      task.agentSessionId,
      expect.objectContaining({
        type: "session_notification",
        delivery_id: "99999999-9999-4999-8999-999999999999",
        disposition: "queued",
        _dedupe_key:
          "session_notification:99999999-9999-4999-8999-999999999999",
      }),
    );
    expect(task.lastEventId).toBe(41);
    expect(persistence.handleSideEffects).toHaveBeenCalledTimes(1);
    expect(broadcaster.emitEventEnvelope).toHaveBeenCalledTimes(1);
  });

  it("does not rebroadcast or reproject a dedupe conflict", async () => {
    const { publisher, persistence, broadcaster } = makeSubject(false);

    await publisher.publish(makeTask(), makeMessage(), "auto_resume");

    expect(persistence.handleSideEffects).not.toHaveBeenCalled();
    expect(broadcaster.emitEventEnvelope).not.toHaveBeenCalled();
  });

  it("rejects a non-notification intent at the event boundary", async () => {
    const { publisher } = makeSubject(true);

    await expect(publisher.publish(
      makeTask(),
      { ...makeMessage(), deliveryIntent: "durable_next_turn" },
      "queued",
    )).rejects.toThrow("session_notification does not support durable_next_turn");
  });

  it("isolates notification persistence failure after delivery without broadcasting", async () => {
    const { publisher, persistence, broadcaster } = makeSubject(true);
    persistence.persistEventWithResult.mockRejectedValueOnce(
      new Error("notification store unavailable"),
    );

    await expect(
      publisher.publish(makeTask(), makeMessage(), "queued"),
    ).resolves.toBeUndefined();

    expect(broadcaster.emitEventEnvelope).not.toHaveBeenCalled();
  });
});
