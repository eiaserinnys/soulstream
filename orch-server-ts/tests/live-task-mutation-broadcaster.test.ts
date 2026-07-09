import { describe, expect, it, vi } from "vitest";

import {
  InMemorySseReplayBroadcaster,
  withTaskMutationBroadcasts,
  type TaskMutationResponse,
  type TaskMutationRouteProvider,
  type TaskStreamEvent,
} from "../src/index.js";

describe("live task mutation broadcaster", () => {
  it("skips route-local append when the DB listener owns task stream changes", async () => {
    const broadcaster = new InMemorySseReplayBroadcaster<TaskStreamEvent>();
    const provider = withTaskMutationBroadcasts(createProvider(), broadcaster, {
      shouldBroadcast: () => false,
    });

    await provider.createTask({
      sessionId: "sess-task",
      title: "Task",
      description: "",
      acceptanceCriteria: "",
      verificationOwner: "agent",
      status: "open",
      setActive: false,
    });

    expect(broadcaster.bufferedEvents).toEqual([]);
  });
});

function createProvider(): TaskMutationRouteProvider {
  const response = {
    task: { id: "task-live", status: "open" },
    operation: {
      id: "op-live",
      taskId: "task-live",
      operationType: "create_task_item",
      actorEventId: 9,
    },
    eventId: 9,
  } satisfies TaskMutationResponse;
  return {
    createTask: vi.fn(async () => response),
    setTaskStatus: vi.fn(async () => response),
    updateTask: vi.fn(async () => response),
    moveTask: vi.fn(async () => response),
    linkTask: vi.fn(async () => response),
    holdTask: vi.fn(async () => response),
    archiveTask: vi.fn(async () => response),
    pinTask: vi.fn(async () => response),
    listTaskOperations: vi.fn(async () => []),
  };
}
