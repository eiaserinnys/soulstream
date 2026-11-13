import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { TaskLifecycleRoute } from "../../src/task/task_lifecycle_route.js";
import { TaskLifecycleTransition } from "../../src/task/task_lifecycle_transition.js";
import type { Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

const silentLogger = pino({ level: "silent" });

/** DB 줄에서 지연 로더가 올린 러너 없는 running task다. */
function makeHydratedRunningTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "sess-hydrated",
    prompt: "hi",
    status: "running",
    hydratedFromDb: true,
    callerSessionId: "parent-session",
    createdAt: new Date("2026-11-13T01:00:00.000Z"),
    lastEventId: 7,
    lastReadEventId: 0,
    interventionQueue: [],
    ...overrides,
  };
}

function makeHarness(task: Task) {
  const order: string[] = [];
  const enqueue = vi.fn(async (
    _sessionId: string,
    _event: unknown,
    effect: {
      status: string;
      termination_reason: string;
      termination_detail: string | null;
      review_state: string;
      updated_at: string;
    },
  ) => {
    order.push("terminal_event");
    return {
      eventId: 8,
      applied: true,
      canonicalSession: {
        status: effect.status,
        termination_reason: effect.termination_reason,
        termination_detail: effect.termination_detail,
        review_state: effect.review_state,
        last_assistant_text: null,
        termination_event_id: 8,
        updated_at: effect.updated_at,
        last_event_id: 8,
      },
    };
  });
  const completionNotifier = {
    notify: vi.fn(async () => { order.push("notify"); }),
    notifyForDelete: vi.fn(async () => { order.push("notify_for_delete"); return true; }),
  };
  const transition = new TaskLifecycleTransition({
    logger: silentLogger,
    persistence: { enqueueTerminalTransitionAndWaitForApplication: enqueue } as never,
    completionNotifier,
  });
  const tasks = new Map([[task.agentSessionId, task]]);
  const deleteSession = vi.fn(async () => { order.push("delete_row"); });
  const route = new TaskLifecycleRoute({
    getTask: (id) => tasks.get(id),
    listTasks: () => [...tasks.values()],
    forgetTask: (id) => { tasks.delete(id); },
    lifecycleTransition: transition,
    sessionMutations: { deleteSession } as never,
    broadcaster: { emitSessionDeleted: vi.fn().mockResolvedValue(undefined) } as unknown as SessionBroadcaster,
    logger: silentLogger,
  });
  return { route, enqueue, completionNotifier, deleteSession, order };
}

describe("card #1266 U4: a running task restored from the DB without a runner", () => {
  it("records the stop and tells the calling session instead of answering SESSION_NOT_RUNNING", async () => {
    const task = makeHydratedRunningTask();
    const { route, enqueue, completionNotifier } = makeHarness(task);

    await expect(route.cancelTask(task.agentSessionId)).resolves.toBe(true);

    expect(enqueue).toHaveBeenCalledOnce();
    expect(task.status).toBe("interrupted");
    expect(task.terminationDetail).toBe("user_stop");
    expect(task.terminationEventRecorded).toBe(true);
    expect(completionNotifier.notify).toHaveBeenCalledOnce();
  });

  it("records the termination and the caller notice before the row is deleted", async () => {
    const task = makeHydratedRunningTask();
    const { route, enqueue, completionNotifier, deleteSession, order } = makeHarness(task);

    await expect(route.deleteTask(task.agentSessionId)).resolves.toBe(true);

    expect(enqueue).toHaveBeenCalledOnce();
    expect(completionNotifier.notifyForDelete).toHaveBeenCalledOnce();
    expect(deleteSession).toHaveBeenCalledOnce();
    expect(order).toEqual(["terminal_event", "notify_for_delete", "delete_row"]);
  });

  it("still deletes a creation-phase task that is not restored from the DB without a stop", async () => {
    const task = makeHydratedRunningTask({ hydratedFromDb: undefined, status: "initializing" });
    const { route, enqueue, deleteSession } = makeHarness(task);

    await expect(route.deleteTask(task.agentSessionId)).resolves.toBe(true);

    expect(enqueue).not.toHaveBeenCalled();
    expect(deleteSession).toHaveBeenCalledOnce();
  });

  it("does not treat a handoff barrier as a pending stop when deleting", async () => {
    const task = makeHydratedRunningTask({
      hydratedFromDb: undefined,
      status: "initializing",
      interruptRequest: new Promise<boolean>(() => undefined),
      interruptBarrierKind: "intervention_handoff",
    });
    const { route, enqueue, deleteSession } = makeHarness(task);

    await expect(route.deleteTask(task.agentSessionId)).resolves.toBe(true);

    expect(enqueue).not.toHaveBeenCalled();
    expect(deleteSession).toHaveBeenCalledOnce();
  });
});
