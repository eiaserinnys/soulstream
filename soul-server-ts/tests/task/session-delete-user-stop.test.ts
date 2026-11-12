/**
 * card #1261 B — 실행 중인 세션의 삭제는 사람이 멈춘 것과 같이 멈춘 뒤 지운다.
 *
 * 노드 삭제 경로(TaskLifecycleRoute.deleteTask)는 실행 중 task를 interruptAndDrain으로
 * 찢지 않고 stop-button 경로(cancelRunningTask → finalizeUserStop, termination_detail
 * user_stop)로 멈춘다. 부른 세션 통지 등록이 끝난 뒤 러너를 닫고 등록을 retire하고,
 * 그 다음 세션 행을 지운다. 이미 끝난 세션은 멈추지 않고 닫고 지운다.
 */
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { TaskLifecycleRoute } from "../../src/task/task_lifecycle_route.js";
import type { Task } from "../../src/task/task_models.js";

const silentLogger = pino({ level: "silent" });

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "sess-delete-1",
    prompt: "hi",
    status: "running",
    callerSessionId: "parent-sess-1",
    createdAt: new Date("2026-11-12T01:00:00.000Z"),
    lastEventId: 7,
    lastReadEventId: 0,
    interventionQueue: [],
    ...overrides,
  };
}

function makeRunner(events: string[]) {
  const retire = vi.fn(async () => {
    events.push("retire-registration");
  });
  const dispatcher = {
    close: vi.fn(async () => {
      events.push("close-runner");
    }),
    retireTerminalRegistration: retire,
  };
  return {
    runner: {
      engine: {},
      dispatcher,
      eventPersistence: "runner",
    },
    dispatcher,
    retire,
  };
}

function makeRoute(params: {
  task: Task;
  events: string[];
  cancel?: (task: Task) => Promise<boolean>;
}) {
  const cancelRunningTask = vi.fn(params.cancel ?? (async (task: Task) => {
    params.events.push("stop-user");
    task.status = "interrupted";
    task.terminationDetail = "user_stop";
    task.runner = undefined;
    return true;
  }));
  const interruptAndDrain = vi.fn(async () => {
    params.events.push("interrupt-and-drain");
  });
  const deleteSession = vi.fn(async () => {
    params.events.push("delete-row");
  });
  const emitSessionDeleted = vi.fn(async () => {
    params.events.push("broadcast");
  });
  const forgetTask = vi.fn();
  const route = new TaskLifecycleRoute({
    getTask: () => params.task,
    listTasks: () => [params.task],
    forgetTask,
    lifecycleTransition: {
      cancelRunningTask,
      interruptAndDrain,
    } as never,
    sessionMutations: { deleteSession } as never,
    broadcaster: { emitSessionDeleted } as never,
    logger: silentLogger,
  });
  return {
    route,
    cancelRunningTask,
    interruptAndDrain,
    deleteSession,
    emitSessionDeleted,
    forgetTask,
  };
}

describe("TaskLifecycleRoute.deleteTask — 멈춘 뒤 삭제 (card #1261)", () => {
  it("실행 중 세션은 멈춤 경로로 user_stop을 기록하고, 러너 종료와 등록 retire 뒤 행을 지운다", async () => {
    const events: string[] = [];
    const task = makeTask();
    const { runner, dispatcher, retire } = makeRunner(events);
    task.runner = runner as never;
    const { route, cancelRunningTask, interruptAndDrain, deleteSession,
      emitSessionDeleted, forgetTask } = makeRoute({ task, events });

    await expect(route.deleteTask("sess-delete-1")).resolves.toBe(true);

    expect(cancelRunningTask).toHaveBeenCalledTimes(1);
    expect(interruptAndDrain).not.toHaveBeenCalled();
    expect(dispatcher.close).toHaveBeenCalled();
    expect(retire).toHaveBeenCalledTimes(1);
    expect(deleteSession).toHaveBeenCalledWith(
      "sess-delete-1",
      "delete_session:sess-delete-1",
    );
    expect(forgetTask).toHaveBeenCalledWith("sess-delete-1");
    expect(emitSessionDeleted).toHaveBeenCalledWith("sess-delete-1");
    expect(events).toEqual([
      "stop-user",
      "close-runner",
      "retire-registration",
      "delete-row",
      "broadcast",
    ]);
    expect(task.terminationDetail).toBe("user_stop");
  });

  it("이미 끝난 세션은 다시 멈추지 않고 러너를 닫은 뒤 지운다", async () => {
    const events: string[] = [];
    const task = makeTask({ status: "completed" });
    const { runner, dispatcher, retire } = makeRunner(events);
    task.runner = runner as never;
    const { route, cancelRunningTask, interruptAndDrain, deleteSession } =
      makeRoute({ task, events });

    await expect(route.deleteTask("sess-delete-1")).resolves.toBe(true);

    expect(cancelRunningTask).not.toHaveBeenCalled();
    expect(interruptAndDrain).not.toHaveBeenCalled();
    expect(dispatcher.close).toHaveBeenCalled();
    expect(retire).toHaveBeenCalledTimes(1);
    expect(deleteSession).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      "close-runner",
      "retire-registration",
      "delete-row",
      "broadcast",
    ]);
  });

  it("멈춤이 확정되지 않아 여전히 실행 중이면 지우지 않고 실패한다", async () => {
    const events: string[] = [];
    const task = makeTask();
    const { runner } = makeRunner(events);
    task.runner = runner as never;
    const { route, deleteSession, emitSessionDeleted, forgetTask } = makeRoute({
      task,
      events,
      cancel: async () => {
        events.push("stop-not-confirmed");
        return false;
      },
    });

    await expect(route.deleteTask("sess-delete-1")).rejects.toThrow(
      /did not converge/,
    );

    expect(deleteSession).not.toHaveBeenCalled();
    expect(forgetTask).not.toHaveBeenCalled();
    expect(emitSessionDeleted).not.toHaveBeenCalled();
  });

  it("메모리에 없는 세션은 false를 돌려주고 아무것도 지우지 않는다", async () => {
    const events: string[] = [];
    const task = makeTask({ status: "completed" });
    const { route, deleteSession } = makeRoute({ task, events });
    const missingRoute = new TaskLifecycleRoute({
      getTask: () => undefined,
      listTasks: () => [],
      forgetTask: vi.fn(),
      lifecycleTransition: { cancelRunningTask: vi.fn() } as never,
      sessionMutations: { deleteSession } as never,
      broadcaster: { emitSessionDeleted: vi.fn() } as never,
      logger: silentLogger,
    });

    await expect(missingRoute.deleteTask("absent")).resolves.toBe(false);
    expect(deleteSession).not.toHaveBeenCalled();
    void route;
  });
});
