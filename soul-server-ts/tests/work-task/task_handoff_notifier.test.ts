import { describe, expect, it, vi } from "vitest";

import {
  TaskHandoffNotifier,
  type TaskHandoffSubscriberQuery,
} from "../../src/work-task/task_handoff_notifier.js";
import type { TaskHandoffEvent } from "../../src/work-task/task_service_models.js";

function createSilentLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: () => createSilentLogger(),
  };
}

describe("TaskHandoffNotifier", () => {
  it("sends a fire-and-forget message to each derived agent subscriber", async () => {
    const query: TaskHandoffSubscriberQuery = {
      listAgentSubscriberSessionIds: vi.fn(async () => ["sess-agent-1", "sess-agent-2"]),
    };
    const sender = {
      send: vi.fn(async () => ({ ok: true, detail: { queued: true } })),
    };
    const logger = createSilentLogger();
    const notifier = new TaskHandoffNotifier(query, sender as never, logger as never);

    notifier.notifyHumanHandoff(makeEvent({ status: "completed" }));
    await flushAsync();

    expect(query.listAgentSubscriberSessionIds).toHaveBeenCalledWith("rb-1");
    expect(sender.send).toHaveBeenCalledTimes(2);
    expect(sender.send).toHaveBeenNthCalledWith(1, {
      targetSessionId: "sess-agent-1",
      message: expect.stringContaining("업무 'Launch'의 'Deploy' 완료됨, 이어서 진행"),
    });
    expect(sender.send).toHaveBeenNthCalledWith(2, {
      targetSessionId: "sess-agent-2",
      message: expect.stringContaining("item_id: item-1"),
    });
  });

  it("does not throw when delivery fails", async () => {
    const query: TaskHandoffSubscriberQuery = {
      listAgentSubscriberSessionIds: vi.fn(async () => ["sess-agent-1"]),
    };
    const sender = {
      send: vi.fn(async () => {
        throw new Error("delivery failed");
      }),
    };
    const logger = createSilentLogger();
    const notifier = new TaskHandoffNotifier(query, sender as never, logger as never);

    expect(() => notifier.notifyHumanHandoff(makeEvent({ status: "cancelled" }))).not.toThrow();
    await flushAsync();

    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();
  });
});

function makeEvent(
  overrides: Partial<TaskHandoffEvent> = {},
): TaskHandoffEvent {
  return {
    taskId: "rb-1",
    taskTitle: "Launch",
    boardItemId: "task:rb-1",
    itemId: "item-1",
    itemTitle: "Deploy",
    status: "completed",
    operationId: "op-1",
    eventId: 12,
    ...overrides,
  };
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}
