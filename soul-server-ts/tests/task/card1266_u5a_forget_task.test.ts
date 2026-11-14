import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { INSTRUCTION_UNCERTAIN_REASON } from "../../src/task/state/node_instruction_decision.js";
import type { InterventionMessage, Task } from "../../src/task/task_models.js";
import { requeueAfterHandoffAttempt, wasHandoffAttempted } from "../../src/task/task_intervention_queue.js";
import { TaskManager } from "../../src/task/task_manager.js";

import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

/**
 * 카드 #1266 U5a 아·차.
 * 아: 잊기는 맵의 지금 값이 넘겨받은 그 task 객체일 때만 지운다(낡은 객체로 새 task를 지우지 않는다).
 * 차: task를 잊을 때 메모리 큐에 남은 지시는 노드 재시작을 기다리지 않고 장부에서 정리된다.
 *     가르는 기준은 노드 자신의 넘김 시도 기록이다. 러너에 넘기려 한 적 없는 지시는 서버가 다시 띄울
 *     수 있게 돌려주고, 넘김 시도 뒤 큐로 되돌아온 지시와 가를 수 없는 지시는 모름(uncertain)으로
 *     둔다. 장부의 dispatching_at은 메모리 큐 지시에는 거의 늘 값이 있어 기준이 아니다.
 */
function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "sess-u5a-forget",
    prompt: "hi",
    status: "running",
    createdAt: new Date("2026-11-14T01:00:00.000Z"),
    lastEventId: 7,
    lastReadEventId: 0,
    interventionQueue: [],
    ...overrides,
  };
}

function row(overrides: Record<string, unknown>) {
  return {
    delivery_id: "d",
    state: "queued",
    aggregate_state: "pending",
    attempt_token: "token-1",
    // 서버가 노드에 넘기기 시작한 표시다. 메모리 큐에 있는 지시에는 거의 늘 값이 있다.
    dispatching_at: new Date(),
    ...overrides,
  };
}

function makeSubject(options: { ledger?: boolean; rows?: Record<string, unknown> } = {}) {
  const rows = new Map<string, Record<string, unknown>>(
    Object.entries(options.rows ?? {}) as [string, Record<string, unknown>][],
  );
  const repository = {
    get: vi.fn(async (id: string) => {
      const found = rows.get(id);
      if (found === undefined && id === "d-boom") throw new Error("ledger read failed");
      return found ?? null;
    }),
    retryDeliveryAttempt: vi.fn(async () => ({})),
    markUncertain: vi.fn(async () => ({})),
  };
  const logger = pino({ level: "silent" });
  const info = vi.spyOn(logger, "info");
  const warn = vi.spyOn(logger, "warn");
  const persistence = makeEventPersistenceTestDouble(undefined, [], {
    capabilityProfile: "legacy_transition_only",
  });
  const db = {
    getSession: vi.fn(async () => null),
    sessionDeliveries: () => repository,
    claudeBackgroundTasks: () => ({}),
  };
  const manager = new TaskManager(
    "node-a",
    db as never,
    {} as never,
    logger,
    persistence.persistence,
    undefined, undefined, undefined, undefined,
    options.ledger ?? true,
  );
  const tasks = (manager as unknown as { tasks: Map<string, Task> }).tasks;
  return { manager, tasks, repository, info, warn };
}

const msg = (deliveryId: string | undefined, extra: Partial<InterventionMessage> = {}): InterventionMessage => ({
  text: `m-${deliveryId ?? "plain"}`,
  user: "u",
  ...(deliveryId === undefined
    ? {}
    : { deliveryId, deliveryIntent: "durable_next_turn" as const }),
  ...extra,
});

describe("card #1266 U5a 아: forgetting a task removes only the task object it was handed", () => {
  it("leaves the newer task of the same session alone and logs one line", () => {
    const subject = makeSubject();
    const stale = makeTask();
    const current = makeTask();
    subject.tasks.set(current.agentSessionId, current);

    subject.manager.forgetRunnerRecoveryTask(stale);

    expect(subject.tasks.get(current.agentSessionId)).toBe(current);
    expect(subject.info).toHaveBeenCalledOnce();
    expect(subject.info).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: stale.agentSessionId, mapHasTask: true }),
      expect.stringContaining("task forget skipped"),
    );
  });

  it("removes the task when the map still holds that very object", () => {
    const subject = makeSubject();
    const task = makeTask();
    subject.tasks.set(task.agentSessionId, task);

    subject.manager.forgetRunnerRecoveryTask(task);

    expect(subject.tasks.has(task.agentSessionId)).toBe(false);
  });

  it("applies the same identity rule to the local-ownership release path of the lifecycle transition", async () => {
    const subject = makeSubject();
    const stale = makeTask();
    const current = makeTask();
    subject.tasks.set(current.agentSessionId, current);
    const lifecycle = (subject.manager as unknown as {
      lifecycleTransition: { releaseLocalOwnership(task: Task): Promise<void> };
    }).lifecycleTransition;

    await lifecycle.releaseLocalOwnership(stale);
    expect(subject.tasks.get(current.agentSessionId)).toBe(current);

    await lifecycle.releaseLocalOwnership(current);
    expect(subject.tasks.has(current.agentSessionId)).toBe(false);
  });

  it("does not touch the ledger rows of a stale task object either", () => {
    const subject = makeSubject({ rows: { "d-1": row({ delivery_id: "d-1" }) } });
    const stale = makeTask({ interventionQueue: [msg("d-1")] });
    subject.tasks.set(stale.agentSessionId, makeTask());

    subject.manager.forgetRunnerRecoveryTask(stale);

    expect(subject.repository.get).not.toHaveBeenCalled();
    expect(stale.interventionQueue).toHaveLength(1);
  });
});

describe("card #1266 U5a 차: instructions queued in a forgotten task settle in the ledger without a node restart", () => {
  it("returns instructions this node never tried to hand to a runner even though the server stamped dispatching_at", async () => {
    const subject = makeSubject({
      rows: {
        "d-fresh": row({ delivery_id: "d-fresh" }),
        "d-done": row({ delivery_id: "d-done", state: "consumed", aggregate_state: "consumed" }),
      },
    });
    const task = makeTask({
      interventionQueue: [msg("d-fresh"), msg("d-done"), msg(undefined), msg("d-gone")],
    });
    subject.tasks.set(task.agentSessionId, task);

    subject.manager.forgetRunnerRecoveryTask(task);

    await vi.waitFor(() => expect(subject.repository.get).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(subject.repository.retryDeliveryAttempt).toHaveBeenCalledOnce());
    expect(subject.repository.retryDeliveryAttempt).toHaveBeenCalledWith(
      "d-fresh",
      "token-1",
      "task_forgotten_before_dispatch",
      0,
    );
    expect(subject.repository.markUncertain).not.toHaveBeenCalled();
    expect(task.interventionQueue).toEqual([]);
    expect(subject.tasks.has(task.agentSessionId)).toBe(false);
  });

  it("marks uncertain an instruction that came back to the queue after a hand-off attempt, and one that cannot be returned", async () => {
    const subject = makeSubject({
      rows: {
        "d-sent": row({ delivery_id: "d-sent", attempt_token: "token-2" }),
        "d-open": row({ delivery_id: "d-open", state: "dispatching", attempt_token: null }),
      },
    });
    const returned = msg("d-sent");
    const holder = makeTask();
    // 넘김을 시도한 뒤 큐로 되돌아오는 자리가 쓰는 함수로 시도 표시를 남긴다.
    requeueAfterHandoffAttempt(holder, returned);
    expect(wasHandoffAttempted(returned)).toBe(true);
    expect(wasHandoffAttempted(msg("d-open"))).toBe(false);
    // 시도 번호가 장부에도 메시지에도 없어 돌려줄 수 없는 줄이다.
    const task = makeTask({ interventionQueue: [returned, msg("d-open")] });
    subject.tasks.set(task.agentSessionId, task);

    subject.manager.forgetRunnerRecoveryTask(task);

    await vi.waitFor(() => expect(subject.repository.markUncertain).toHaveBeenCalledTimes(2));
    expect(subject.repository.retryDeliveryAttempt).not.toHaveBeenCalled();
    expect(subject.repository.markUncertain).toHaveBeenCalledWith(
      "d-sent", "token-2", INSTRUCTION_UNCERTAIN_REASON,
    );
    expect(subject.repository.markUncertain).toHaveBeenCalledWith(
      "d-open", undefined, INSTRUCTION_UNCERTAIN_REASON,
    );
  });

  it("settles the other instructions when one ledger read fails and logs the failure", async () => {
    const subject = makeSubject({ rows: { "d-fresh": row({ delivery_id: "d-fresh" }) } });
    const task = makeTask({ interventionQueue: [msg("d-boom"), msg("d-fresh")] });
    subject.tasks.set(task.agentSessionId, task);

    subject.manager.forgetRunnerRecoveryTask(task);

    await vi.waitFor(() => expect(subject.repository.retryDeliveryAttempt).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(subject.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: task.agentSessionId, queued: 2 }),
      expect.stringContaining("could not be settled in the ledger"),
    ));
  });

  it("does nothing in the ledger on a node without the delivery ledger", async () => {
    const subject = makeSubject({ ledger: false, rows: { "d-1": row({ delivery_id: "d-1" }) } });
    const task = makeTask({ interventionQueue: [msg("d-1")] });
    subject.tasks.set(task.agentSessionId, task);

    subject.manager.forgetRunnerRecoveryTask(task);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(subject.repository.get).not.toHaveBeenCalled();
    expect(subject.tasks.has(task.agentSessionId)).toBe(false);
  });
});
