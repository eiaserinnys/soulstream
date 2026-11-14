import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { INSTRUCTION_UNCERTAIN_REASON } from "../../src/task/state/node_instruction_decision.js";
import type { InterventionMessage, Task } from "../../src/task/task_models.js";
import { TaskManager } from "../../src/task/task_manager.js";

import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

/**
 * 카드 #1266 U5a 아·차.
 * 아: 잊기는 맵의 지금 값이 넘겨받은 그 task 객체일 때만 지운다(낡은 객체로 새 task를 지우지 않는다).
 * 차: task를 잊을 때 메모리 큐에 남은 지시는 노드 재시작을 기다리지 않고 장부에서 정리된다.
 *     러너에 넘긴 적 없는 지시는 서버가 다시 띄울 수 있게 돌려주고, 넘긴 적 있거나 가를 수 없는
 *     지시는 모름(uncertain)으로 둔다.
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
    dispatching_at: null,
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
  it("returns never-dispatched instructions and marks dispatched or undecidable ones uncertain", async () => {
    const subject = makeSubject({
      rows: {
        "d-fresh": row({ delivery_id: "d-fresh" }),
        "d-sent": row({ delivery_id: "d-sent", dispatching_at: new Date(), attempt_token: "token-2" }),
        "d-open": row({ delivery_id: "d-open", state: "dispatching", dispatching_at: new Date(), attempt_token: null }),
        "d-done": row({ delivery_id: "d-done", state: "consumed", aggregate_state: "consumed" }),
      },
    });
    const task = makeTask({
      interventionQueue: [msg("d-fresh"), msg("d-sent"), msg("d-open"), msg("d-done"), msg(undefined), msg("d-gone")],
    });
    subject.tasks.set(task.agentSessionId, task);

    subject.manager.forgetRunnerRecoveryTask(task);

    await vi.waitFor(() => expect(subject.repository.get).toHaveBeenCalledTimes(5));
    await vi.waitFor(() => expect(subject.repository.markUncertain).toHaveBeenCalledTimes(2));
    expect(subject.repository.retryDeliveryAttempt).toHaveBeenCalledOnce();
    expect(subject.repository.retryDeliveryAttempt).toHaveBeenCalledWith(
      "d-fresh",
      "token-1",
      "task_forgotten_before_dispatch",
      0,
    );
    expect(subject.repository.markUncertain).toHaveBeenCalledWith(
      "d-sent", "token-2", INSTRUCTION_UNCERTAIN_REASON,
    );
    expect(subject.repository.markUncertain).toHaveBeenCalledWith(
      "d-open", undefined, INSTRUCTION_UNCERTAIN_REASON,
    );
    expect(task.interventionQueue).toEqual([]);
    expect(subject.tasks.has(task.agentSessionId)).toBe(false);
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
