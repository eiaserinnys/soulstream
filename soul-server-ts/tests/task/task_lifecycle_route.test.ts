import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { SessionDB } from "../../src/db/session_db.js";
import type { EnginePort } from "../../src/engine/protocol.js";
import {
  TaskLifecycleRoute,
  type TaskLifecycleTransitionPort,
} from "../../src/task/task_lifecycle_route.js";
import type { Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

const silentLogger = pino({ level: "silent" });

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "sess-1",
    prompt: "hi",
    status: "running",
    createdAt: new Date("2026-05-23T01:00:00.000Z"),
    lastEventId: 7,
    lastReadEventId: 0,
    interventionQueue: [],
    ...overrides,
  };
}

function makeRoute(
  initialTasks: Task[] = [],
  onForget: (sessionId: string) => void = () => undefined,
) {
  const tasks = new Map(initialTasks.map((task) => [task.agentSessionId, task]));
  const deleteSession = vi.fn().mockResolvedValue(undefined);
  const db = { deleteSession } as unknown as SessionDB;

  const emitSessionDeleted = vi.fn().mockResolvedValue(undefined);
  const broadcaster = { emitSessionDeleted } as unknown as SessionBroadcaster;

  const lifecycleTransition = {
    cancelRunningTask: vi.fn().mockResolvedValue(true),
    interruptAndDrain: vi.fn().mockResolvedValue(undefined),
    markRunningTaskInterruptedForShutdown: vi.fn().mockResolvedValue(undefined),
    interruptForShutdown: vi.fn().mockResolvedValue(undefined),
    getDrainPromise: vi.fn().mockReturnValue(Promise.resolve()),
    finalizeExternalTask: vi.fn(async (task: Task) => task),
  } satisfies TaskLifecycleTransitionPort;

  const route = new TaskLifecycleRoute({
    getTask: (sessionId) => tasks.get(sessionId),
    listTasks: () => Array.from(tasks.values()),
    forgetTask: (sessionId) => {
      onForget(sessionId);
      tasks.delete(sessionId);
    },
    lifecycleTransition,
    db,
    broadcaster,
    logger: silentLogger,
  });

  return {
    route,
    tasks,
    deleteSession,
    emitSessionDeleted,
    lifecycleTransition,
  };
}

describe("TaskLifecycleRoute.cancelTask", () => {
  it("looks up the task and delegates cancellation policy to TaskLifecycleTransition", async () => {
    const task = makeTask({ agentSessionId: "s1" });
    const { route, lifecycleTransition } = makeRoute([task]);

    await expect(route.cancelTask("s1")).resolves.toBe(true);

    expect(lifecycleTransition.cancelRunningTask).toHaveBeenCalledWith(task);
  });
});

describe("TaskLifecycleRoute.deleteTask", () => {
  it("interrupts and drains before forgetting the task, then deletes DB row and broadcasts", async () => {
    const events: string[] = [];
    const task = makeTask({ agentSessionId: "s1" });
    const {
      route,
      tasks,
      deleteSession,
      emitSessionDeleted,
      lifecycleTransition,
    } = makeRoute([task], () => {
      events.push("forget");
    });
    vi.mocked(lifecycleTransition.interruptAndDrain).mockImplementationOnce(async () => {
      events.push("interrupt");
    });
    deleteSession.mockImplementationOnce(async () => {
      events.push("delete");
    });
    emitSessionDeleted.mockImplementationOnce(async () => {
      events.push("broadcast");
    });

    await route.deleteTask("s1");

    expect(tasks.has("s1")).toBe(false);
    expect(lifecycleTransition.interruptAndDrain).toHaveBeenCalledWith(task);
    expect(deleteSession).toHaveBeenCalledWith("s1");
    expect(emitSessionDeleted).toHaveBeenCalledWith("s1");
    expect(events).toEqual(["interrupt", "forget", "delete", "broadcast"]);
  });

  it("treats missing sessions as no-op and isolates delete side-effect failures", async () => {
    const task = makeTask({ agentSessionId: "s1" });
    const { route, tasks, deleteSession, emitSessionDeleted } = makeRoute([task]);
    deleteSession.mockRejectedValueOnce(new Error("db down"));
    emitSessionDeleted.mockRejectedValueOnce(new Error("ws down"));

    await expect(route.deleteTask("missing")).resolves.toBeUndefined();
    expect(deleteSession).not.toHaveBeenCalled();
    expect(emitSessionDeleted).not.toHaveBeenCalled();

    await expect(route.deleteTask("s1")).resolves.toBeUndefined();
    expect(tasks.has("s1")).toBe(false);
    expect(deleteSession).toHaveBeenCalledWith("s1");
    expect(emitSessionDeleted).toHaveBeenCalledWith("s1");
  });
});

describe("TaskLifecycleRoute.shutdown", () => {
  it("marks running tasks, interrupts every task, and collects drains only for tasks that had engines", async () => {
    const running = makeTask({ agentSessionId: "running" });
    const terminalWithEngine = makeTask({
      agentSessionId: "terminal",
      status: "completed",
    });
    const noEngine = makeTask({ agentSessionId: "no-engine" });
    running.engine = { interrupt: vi.fn() } as unknown as EnginePort;
    terminalWithEngine.engine = { interrupt: vi.fn() } as unknown as EnginePort;
    const { route, lifecycleTransition } = makeRoute([
      running,
      terminalWithEngine,
      noEngine,
    ]);

    await route.shutdown();

    expect(
      lifecycleTransition.markRunningTaskInterruptedForShutdown,
    ).toHaveBeenCalledTimes(2);
    expect(lifecycleTransition.markRunningTaskInterruptedForShutdown).toHaveBeenCalledWith(
      running,
      expect.any(Date),
    );
    expect(lifecycleTransition.markRunningTaskInterruptedForShutdown).toHaveBeenCalledWith(
      noEngine,
      expect.any(Date),
    );
    expect(lifecycleTransition.interruptForShutdown).toHaveBeenCalledWith(running);
    expect(lifecycleTransition.interruptForShutdown).toHaveBeenCalledWith(terminalWithEngine);
    expect(lifecycleTransition.interruptForShutdown).toHaveBeenCalledWith(noEngine);
    expect(lifecycleTransition.getDrainPromise).toHaveBeenCalledTimes(2);
    expect(lifecycleTransition.getDrainPromise).toHaveBeenCalledWith(running);
    expect(lifecycleTransition.getDrainPromise).toHaveBeenCalledWith(terminalWithEngine);
  });
});

describe("TaskLifecycleRoute.finalizeTask", () => {
  it("validates public input, returns undefined for missing tasks, and delegates final state mutation", async () => {
    const task = makeTask({ agentSessionId: "s1" });
    const { route, lifecycleTransition } = makeRoute([task]);

    await expect(route.finalizeTask({ agentSessionId: "s1" })).rejects.toThrow(
      /requires either result or error/,
    );
    await expect(route.finalizeTask({
      agentSessionId: "missing",
      result: "done",
    })).resolves.toBeUndefined();

    await expect(route.finalizeTask({
      agentSessionId: "s1",
      result: "done",
    })).resolves.toBe(task);
    expect(lifecycleTransition.finalizeExternalTask).toHaveBeenCalledWith(task, {
      result: "done",
    });
  });
});
