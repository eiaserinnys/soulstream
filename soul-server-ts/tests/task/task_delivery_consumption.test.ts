import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { TaskDeliveryConsumption } from "../../src/task/task_delivery_consumption.js";
import type { InterventionMessage, Task } from "../../src/task/task_models.js";

function makeTask(): Task {
  return {
    agentSessionId: "caller-1",
    prompt: "delivery turn",
    status: "running",
    createdAt: new Date("2026-07-26T00:00:00Z"),
    lastEventId: 91,
    lastReadEventId: 0,
    interventionQueue: [],
  };
}

function makeMessage(): InterventionMessage {
  return {
    text: "child result",
    user: "agent",
    deliveryId: "88888888-8888-4888-8888-888888888888",
    deliveryIntent: "completion_notification",
  };
}

describe("TaskDeliveryConsumption", () => {
  it("records a delivery as consumed only after its foreground turn succeeds", async () => {
    const recorder = {
      recordConsumed: vi.fn().mockResolvedValue(undefined),
      recordTurnStarted: vi.fn().mockResolvedValue(undefined),
    };
    const subject = new TaskDeliveryConsumption(
      recorder,
      { warn: vi.fn() } as unknown as Logger,
    );
    const task = makeTask();
    const message = makeMessage();

    await subject.recordConsumed(task, message);

    expect(recorder.recordConsumed).toHaveBeenCalledWith(message, task);
    expect(recorder.recordTurnStarted).not.toHaveBeenCalled();
  });

  it("records delivered when the queued message becomes foreground input", async () => {
    const recorder = {
      recordConsumed: vi.fn().mockResolvedValue(undefined),
      recordTurnStarted: vi.fn().mockResolvedValue(undefined),
    };
    const subject = new TaskDeliveryConsumption(
      recorder,
      { warn: vi.fn() } as unknown as Logger,
    );
    const task = makeTask();
    const message = makeMessage();

    await expect(subject.recordTurnStarted(task, message)).resolves.toBe(true);

    expect(recorder.recordTurnStarted).toHaveBeenCalledWith(message, task);
    expect(recorder.recordConsumed).not.toHaveBeenCalled();
  });

  it("isolates ordinary receipt failures but fails closed for child consumption", async () => {
    const warn = vi.fn();
    const subject = new TaskDeliveryConsumption(
      {
        recordConsumed: vi.fn().mockRejectedValue(new Error("db unavailable")),
        recordTurnStarted: vi.fn().mockRejectedValue(new Error("db unavailable")),
      },
      { warn } as unknown as Logger,
    );

    await expect(subject.recordTurnStarted(makeTask(), makeMessage())).resolves.toBe(false);
    await expect(subject.recordConsumed(makeTask(), makeMessage())).resolves.toBeUndefined();
    await expect(subject.recordConsumed(makeTask(), {
      ...makeMessage(),
      completionId: "completion-child",
      relationKey: "child_session:child-1:42",
    })).rejects.toThrow("db unavailable");
    expect(warn).toHaveBeenCalledTimes(3);
  });
});
