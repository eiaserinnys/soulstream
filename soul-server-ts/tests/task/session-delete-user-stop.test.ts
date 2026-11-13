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
import { TaskLifecycleTransition } from
  "../../src/task/task_lifecycle_transition.js";
import { TaskCompletionNotifier } from
  "../../src/task/completion_notifier.js";
import type {
  RegisterSessionDeliveryParams,
  RegisterSessionDeliveryResult,
} from "../../src/db/session_db_types.js";
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
    interrupt: vi.fn(async () => {
      events.push("interrupt");
      return true;
    }),
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

/**
 * 진짜 TaskLifecycleTransition을 세운다. 삭제 경로가 멈춤의 영속과 통지 등록을
 * 실제로 확인하는지 보려면 fake 전이로는 부족하다.
 */
function makeStrictRoute(params: {
  task: Task;
  persistence: {
    enqueueTerminalTransitionAndWaitForApplication: (
      ...args: never[]
    ) => Promise<unknown>;
  };
  completionNotifier: {
    notify(task: Task): Promise<void>;
    notifyForDelete?(task: Task): Promise<boolean>;
  };
}) {
  const events: string[] = [];
  const deleteSession = vi.fn(async () => {
    events.push("delete-row");
  });
  const emitSessionDeleted = vi.fn(async () => {
    events.push("broadcast");
  });
  const forgetTask = vi.fn();
  const transition = new TaskLifecycleTransition({
    logger: silentLogger,
    persistence: params.persistence as never,
    completionNotifier: params.completionNotifier,
  });
  const route = new TaskLifecycleRoute({
    getTask: () => params.task,
    listTasks: () => [params.task],
    forgetTask,
    lifecycleTransition: transition,
    sessionMutations: { deleteSession } as never,
    broadcaster: { emitSessionDeleted } as never,
    logger: silentLogger,
  });
  return { route, deleteSession, emitSessionDeleted, forgetTask };
}

type TerminalEffect = {
  status: string;
  termination_reason: string;
  termination_detail: string | null;
  review_state: string;
  last_assistant_text?: string | null;
  updated_at: string;
};

/** 종료 전이가 실제로 적용된 것처럼 canonical 투영을 돌려준다. */
function appliedApplication(effect: TerminalEffect) {
  return {
    eventId: 8,
    applied: true,
    canonicalSession: {
      status: effect.status,
      termination_reason: effect.termination_reason,
      termination_detail: effect.termination_detail,
      review_state: effect.review_state,
      last_assistant_text: effect.last_assistant_text ?? null,
      termination_event_id: 8,
      updated_at: effect.updated_at,
      last_event_id: 8,
    },
  };
}

function appliedPersistence() {
  return {
    enqueueTerminalTransitionAndWaitForApplication: vi.fn(async (
      _sessionId: string,
      _event: unknown,
      effect: TerminalEffect,
    ) => appliedApplication(effect)),
  };
}

/**
 * 진짜 CompletionDeliveryCoordinator가 쓰는 등록 repository. 등록 결과/실패를
 * 시험마다 실제로 돌려주려고 최소 표면만 채운다.
 */
function makeDeliveryRepository(
  register: (
    params: RegisterSessionDeliveryParams,
  ) => Promise<RegisterSessionDeliveryResult>,
) {
  return {
    register: vi.fn(register),
    get: vi.fn(async () => null),
    claimAttemptForTarget: vi.fn(async () => null),
    deferPending: vi.fn(async () => undefined),
    retryDeliveryAttempt: vi.fn(async () => null),
    expireStaleDeliveryAttempts: vi.fn(async () => 0),
    markUncertain: vi.fn(async () => null),
  };
}

/** 실제 TaskCompletionNotifier — v2 등록 결과가 삭제 판정에 닿는지 본다. */
function makeRealNotifier(
  deliveryRepository: ReturnType<typeof makeDeliveryRepository>,
): TaskCompletionNotifier {
  return new TaskCompletionNotifier(
    "node-test",
    { addIntervention: vi.fn() } as never,
    { get: vi.fn() } as never,
    vi.fn() as never,
    silentLogger,
    undefined,
    undefined,
    undefined,
    true,
    deliveryRepository as never,
  );
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

  it("삭제 중 멈춤의 영속이 실패하면 줄을 지우지 않고 삭제가 실패한다", async () => {
    const events: string[] = [];
    const task = makeTask();
    const { runner } = makeRunner(events);
    task.runner = runner as never;
    const persistence = {
      enqueueTerminalTransitionAndWaitForApplication: vi.fn(async () => {
        throw new Error("durable event store unavailable");
      }),
    };
    const { route, deleteSession, emitSessionDeleted, forgetTask } =
      makeStrictRoute({
        task,
        persistence,
        completionNotifier: { notify: vi.fn(async () => {}) },
      });

    await expect(route.deleteTask("sess-delete-1")).rejects.toThrow(
      /terminal persistence failed before delete/,
    );

    expect(persistence.enqueueTerminalTransitionAndWaitForApplication)
      .toHaveBeenCalledOnce();
    expect(deleteSession).not.toHaveBeenCalled();
    expect(forgetTask).not.toHaveBeenCalled();
    expect(emitSessionDeleted).not.toHaveBeenCalled();
  });

  it("영속이 실패한 뒤 다시 지워도 영속이 확인되기 전에는 지우지 않는다", async () => {
    const events: string[] = [];
    const task = makeTask();
    const { runner } = makeRunner(events);
    task.runner = runner as never;
    let persistenceHealthy = false;
    const persistence = {
      enqueueTerminalTransitionAndWaitForApplication: vi.fn(async (
        _sessionId: string,
        _event: unknown,
        effect: TerminalEffect,
      ) => {
        if (!persistenceHealthy) {
          throw new Error("durable event store unavailable");
        }
        return appliedApplication(effect);
      }),
    };
    const repository = makeDeliveryRepository(async (params) => ({
      row: {
        delivery_id: params.deliveryId,
        relation_key: params.relationKey,
      } as never,
      inserted: true,
      conflict: false,
    }));
    const { route, deleteSession } = makeStrictRoute({
      task,
      persistence,
      completionNotifier: makeRealNotifier(repository),
    });

    await expect(route.deleteTask("sess-delete-1")).rejects.toThrow(
      /terminal persistence failed before delete/,
    );
    expect(deleteSession).not.toHaveBeenCalled();

    // 같은 세션을 다시 지워도 영속이 또 실패하면 줄은 남는다. status가 이미
    // 종료값이어도 멈춤 마무리를 건너뛰지 않는다.
    await expect(route.deleteTask("sess-delete-1")).rejects.toThrow(
      /terminal persistence failed before delete/,
    );
    expect(persistence.enqueueTerminalTransitionAndWaitForApplication)
      .toHaveBeenCalledTimes(2);
    expect(repository.register).not.toHaveBeenCalled();
    expect(deleteSession).not.toHaveBeenCalled();

    // 영속이 회복되면 통지 등록을 확인한 뒤에만 지운다.
    persistenceHealthy = true;
    await expect(route.deleteTask("sess-delete-1")).resolves.toBe(true);
    expect(persistence.enqueueTerminalTransitionAndWaitForApplication)
      .toHaveBeenCalledTimes(3);
    expect(repository.register).toHaveBeenCalledOnce();
    expect(deleteSession).toHaveBeenCalledOnce();
  });

  it("통지 등록이 실패하면 다시 지울 때 등록을 재시도하고 성공해야만 지운다", async () => {
    const events: string[] = [];
    const task = makeTask();
    const { runner } = makeRunner(events);
    task.runner = runner as never;
    let registerAttempts = 0;
    const repository = makeDeliveryRepository(async (params) => {
      registerAttempts += 1;
      if (registerAttempts === 1) {
        throw new Error("delivery registration failed");
      }
      // 같은 relation key의 행이 이미 있는 conflict — 이번 revision은 등록된 것이다.
      return {
        row: {
          delivery_id: params.deliveryId,
          relation_key: params.relationKey,
        } as never,
        inserted: false,
        conflict: true,
      };
    });
    const { route, deleteSession, emitSessionDeleted, forgetTask } =
      makeStrictRoute({
        task,
        persistence: appliedPersistence(),
        completionNotifier: makeRealNotifier(repository),
      });

    await expect(route.deleteTask("sess-delete-1")).rejects.toThrow(
      /notification registration failed before delete/,
    );

    expect(repository.register).toHaveBeenCalledOnce();
    expect(deleteSession).not.toHaveBeenCalled();
    expect(forgetTask).not.toHaveBeenCalled();
    expect(emitSessionDeleted).not.toHaveBeenCalled();

    await expect(route.deleteTask("sess-delete-1")).resolves.toBe(true);
    expect(repository.register).toHaveBeenCalledTimes(2);
    expect(repository.register.mock.calls[1][0].relationKey).toBe(
      repository.register.mock.calls[0][0].relationKey,
    );
    expect(deleteSession).toHaveBeenCalledOnce();
  });

  it("죽은 전달 행은 되살림을 요청해 전달을 시도한 뒤에 지운다", async () => {
    const events: string[] = [];
    const task = makeTask();
    const { runner } = makeRunner(events);
    task.runner = runner as never;
    const deadRow = (params: RegisterSessionDeliveryParams) => ({
      delivery_id: params.deliveryId,
      relation_key: params.relationKey,
      state: "uncertain",
      aggregate_state: "dead_letter",
    }) as never;
    const pendingRow = (params: RegisterSessionDeliveryParams) => ({
      delivery_id: params.deliveryId,
      relation_key: params.relationKey,
      target_session_id: "caller-1",
      state: "pending",
      aggregate_state: "pending",
      attempt_count: 0,
    }) as never;
    let revivedRow: unknown = null;
    const repository = makeDeliveryRepository(async (params) => {
      // 되살림 요청이 있어야 행이 살아난다. 요청이 없으면 죽은 행 그대로다.
      const revive = (params as { reviveDeadLetter?: boolean }).reviveDeadLetter === true;
      revivedRow = revive ? pendingRow(params) : null;
      return {
        row: revive ? pendingRow(params) : deadRow(params),
        inserted: false,
        conflict: false,
      };
    });
    repository.get.mockImplementation(async () => revivedRow as never);
    const { route, deleteSession } = makeStrictRoute({
      task,
      persistence: appliedPersistence(),
      completionNotifier: makeRealNotifier(repository),
    });

    await expect(route.deleteTask("sess-delete-1")).resolves.toBe(true);

    expect(repository.register.mock.calls[0][0]).toMatchObject({
      reviveDeadLetter: true,
    });
    expect(repository.claimAttemptForTarget).toHaveBeenCalledOnce();
    expect(deleteSession).toHaveBeenCalledOnce();
  });

  it("되살림 요청 뒤에도 행이 죽어 있으면 삭제를 멈춘다", async () => {
    const events: string[] = [];
    const task = makeTask();
    const { runner } = makeRunner(events);
    task.runner = runner as never;
    const repository = makeDeliveryRepository(async (params) => ({
      row: {
        delivery_id: params.deliveryId,
        relation_key: params.relationKey,
        state: "uncertain",
        aggregate_state: "dead_letter",
      } as never,
      inserted: false,
      conflict: true,
    }));
    const { route, deleteSession, forgetTask } = makeStrictRoute({
      task,
      persistence: appliedPersistence(),
      completionNotifier: makeRealNotifier(repository),
    });

    await expect(route.deleteTask("sess-delete-1")).rejects.toThrow(
      /notification registration failed before delete/,
    );

    expect(repository.claimAttemptForTarget).not.toHaveBeenCalled();
    expect(deleteSession).not.toHaveBeenCalled();
    expect(forgetTask).not.toHaveBeenCalled();
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
