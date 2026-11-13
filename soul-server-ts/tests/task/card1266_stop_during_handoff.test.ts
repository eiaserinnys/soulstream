import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { EnginePort } from "../../src/engine/protocol.js";
import { createInProcessTaskRunnerRuntime } from
  "../../src/runner/task_runner_runtime.js";
import { TaskLifecycleTransition } from "../../src/task/task_lifecycle_transition.js";
import type { Task } from "../../src/task/task_models.js";
import { RunningInterventionTransition } from
  "../../src/task/task_running_intervention_transition.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

const silentLogger = pino({ level: "silent" });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "sess-handoff",
    prompt: "hi",
    status: "running",
    modelPresetBackend: "antigravity",
    createdAt: new Date("2026-11-13T01:00:00.000Z"),
    lastEventId: 7,
    lastReadEventId: 0,
    interventionQueue: [],
    ...overrides,
  };
}

function makeLifecycle() {
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
  ) => ({
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
  }));
  const transition = new TaskLifecycleTransition({
    logger: silentLogger,
    persistence: { enqueueTerminalTransitionAndWaitForApplication: enqueue } as never,
  });
  return { transition, enqueue };
}

function makeDelivery() {
  return new RunningInterventionTransition({
    broadcaster: { emitEventEnvelope: vi.fn().mockResolvedValue(undefined) } as unknown as SessionBroadcaster,
    logger: silentLogger,
    persistence: makeEventPersistenceTestDouble().persistence,
  });
}

describe("card #1266 U4: a stop that arrives while an intervention is being handed over", () => {
  it("interrupts the runner after the handoff ends and finishes the session as stopped", async () => {
    const handoff = deferred<{ status: "not_delivered"; mechanism: string; reason: string }>();
    const interrupt = vi.fn().mockResolvedValue(true);
    const intervene = vi.fn(() => handoff.promise);
    const task = makeTask({
      runner: createInProcessTaskRunnerRuntime({
        backendId: "antigravity",
        workspaceDir: "/tmp/agy",
        async *execute() {},
        interrupt,
        async close() {},
        intervene,
        injectAtToolBoundary: vi.fn(),
      } as unknown as EnginePort),
    });
    const { transition, enqueue } = makeLifecycle();
    const delivery = makeDelivery();

    const delivering = delivery.deliver(task, { text: "새 정보", user: "browser", callerInfo: { source: "browser" } });
    await vi.waitFor(() => expect(intervene).toHaveBeenCalledOnce());
    const stopping = transition.cancelRunningTask(task);
    await Promise.resolve();
    expect(interrupt).not.toHaveBeenCalled();

    handoff.resolve({ status: "not_delivered", mechanism: "interrupt_then_next_turn", reason: "next_turn_required" });
    await delivering;

    await expect(stopping).resolves.toBe(true);
    expect(interrupt).toHaveBeenCalledOnce();
    expect(task.status).toBe("interrupted");
    expect(task.terminationDetail).toBe("user_stop");
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("lets two stops that wait on the same handoff share one interrupt", async () => {
    const handoff = deferred<{ status: "not_delivered"; mechanism: string; reason: string }>();
    const interrupt = vi.fn().mockResolvedValue(true);
    const intervene = vi.fn(() => handoff.promise);
    const task = makeTask({
      runner: createInProcessTaskRunnerRuntime({
        backendId: "antigravity",
        workspaceDir: "/tmp/agy",
        async *execute() {},
        interrupt,
        async close() {},
        intervene,
        injectAtToolBoundary: vi.fn(),
      } as unknown as EnginePort),
    });
    const { transition, enqueue } = makeLifecycle();
    const delivery = makeDelivery();

    const delivering = delivery.deliver(task, { text: "새 정보", user: "browser", callerInfo: { source: "browser" } });
    await vi.waitFor(() => expect(intervene).toHaveBeenCalledOnce());
    const first = transition.cancelRunningTask(task);
    const second = transition.cancelRunningTask(task);
    handoff.resolve({ status: "not_delivered", mechanism: "interrupt_then_next_turn", reason: "next_turn_required" });
    await delivering;

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(interrupt).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledOnce();
  });
});
