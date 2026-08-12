import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { EnginePort } from "../../src/engine/protocol.js";
import { InProcessRunnerCommandDispatcher } from
  "../../src/runner/runner_command_dispatcher.js";
import { TaskLifecycleTransition } from "../../src/task/task_lifecycle_transition.js";
import type { Task } from "../../src/task/task_models.js";

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

function makeMocks() {
  const enqueueEventAndWaitForSessionAck = vi.fn().mockResolvedValue({
    record: { source_seq: 8 },
    eventId: 8,
  });

  const transition = new TaskLifecycleTransition({
    logger: silentLogger,
    persistence: { enqueueEventAndWaitForSessionAck } as never,
  });

  return {
    transition,
    enqueueEventAndWaitForSessionAck,
  };
}

describe("TaskLifecycleTransition.cancelRunningTask", () => {
  it("marks running tasks interrupted before the interrupt command ACK", async () => {
    const { transition } = makeMocks();
    const task = makeTask();
    const interrupt = vi.fn(async () => {
      expect(task.status).toBe("interrupted");
      return true;
    });
    const engine = { interrupt } as unknown as EnginePort;
    const runnerCommandDispatcher = new InProcessRunnerCommandDispatcher(engine);
    const dispatch = vi.spyOn(runnerCommandDispatcher, "dispatch");
    task.runner = { engine, dispatcher: runnerCommandDispatcher };

    await expect(transition.cancelRunningTask(task)).resolves.toBe(true);

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      channel: "command",
      kind: "interrupt",
      commandId: expect.any(String),
    }));
    expect(interrupt).toHaveBeenCalledOnce();
  });

  it("returns false without mutation when task is missing, terminal, or has no engine", async () => {
    const { transition } = makeMocks();
    const terminal = makeTask({ status: "completed" });
    const engine = { interrupt: vi.fn() } as unknown as EnginePort;
    terminal.runner = {
      engine,
      dispatcher: new InProcessRunnerCommandDispatcher(engine),
    };
    const noEngine = makeTask();

    await expect(transition.cancelRunningTask(undefined)).resolves.toBe(false);
    await expect(transition.cancelRunningTask(terminal)).resolves.toBe(false);
    await expect(transition.cancelRunningTask(noEngine)).resolves.toBe(false);

    expect(terminal.status).toBe("completed");
    expect(noEngine.status).toBe("running");
  });
});

describe("TaskLifecycleTransition.finalizeExternalTask", () => {
  it("records completed result, usage, and final-state side effects", async () => {
    const { transition, enqueueEventAndWaitForSessionAck } = makeMocks();
    const task = makeTask({ lastAssistantText: "final answer" });

    const result = await transition.finalizeExternalTask(task, {
      result: "done",
      llmUsage: { input_tokens: 1, output_tokens: 2 },
    });

    expect(result).toBe(task);
    expect(task.status).toBe("completed");
    expect(task.result).toBe("done");
    expect(task.error).toBeUndefined();
    expect(task.llmUsage).toEqual({ input_tokens: 1, output_tokens: 2 });
    expect(task.completedAt).toBeInstanceOf(Date);
    expect(enqueueEventAndWaitForSessionAck).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ type: "session_ended" }),
      expect.objectContaining({
        kind: "terminal_transition",
        status: "completed",
        termination_reason: "completed_ok",
        review_state: "acknowledged",
        last_assistant_text: "final answer",
      }),
    );
  });

  it("enqueues and ACKs session_ended once when finalizing a completed task", async () => {
    const { transition, enqueueEventAndWaitForSessionAck } = makeMocks();
    const task = makeTask();

    await transition.finalizeExternalTask(task, { result: "done" });
    await expect(transition.persistExecutorFinalState(task)).resolves.toBe(false);

    expect(task.terminationReason).toBe("completed_ok");
    expect(enqueueEventAndWaitForSessionAck).toHaveBeenCalledTimes(1);
    expect(enqueueEventAndWaitForSessionAck).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({
        type: "session_ended",
        status: "completed",
        termination_reason: "completed_ok",
      }),
      expect.objectContaining({
        kind: "terminal_transition",
        status: "completed",
        termination_reason: "completed_ok",
      }),
    );
  });

  it("lets completed_ok outrank a prior limit_hit hint", async () => {
    const { transition, enqueueEventAndWaitForSessionAck } = makeMocks();
    const task = makeTask({
      pendingTerminationHint: "limit_hit",
      pendingTerminationDetail: "rate limited once",
    });

    await transition.finalizeExternalTask(task, { result: "done" });

    expect(task.terminationReason).toBe("completed_ok");
    expect(enqueueEventAndWaitForSessionAck.mock.calls[0]?.[2]).toMatchObject({
      kind: "terminal_transition",
      termination_reason: "completed_ok",
    });
  });

  it("records error result and clears stale completed result", async () => {
    const { transition, enqueueEventAndWaitForSessionAck } = makeMocks();
    const task = makeTask({ result: "old" });

    await transition.finalizeExternalTask(task, { error: "boom" });

    expect(task.status).toBe("error");
    expect(task.error).toBe("boom");
    expect(task.result).toBeUndefined();
    expect(task.completedAt).toBeInstanceOf(Date);
    expect(enqueueEventAndWaitForSessionAck.mock.calls[0]?.[2]).toMatchObject({
      status: "error",
      termination_reason: "unknown",
      review_state: "acknowledged",
    });
  });

  it("marks every human-owned terminal result as needs_review", async () => {
    const { transition, enqueueEventAndWaitForSessionAck } = makeMocks();
    const task = makeTask({
      reviewRequired: true,
      reviewState: "acknowledged",
    });

    await transition.finalizeExternalTask(task, { result: "new result" });

    expect(task.reviewState).toBe("needs_review");
    expect(enqueueEventAndWaitForSessionAck.mock.calls[0]?.[2]).toMatchObject({
      review_state: "needs_review",
    });
  });

  it("auto-acknowledges a non-user terminal result", async () => {
    const { transition, enqueueEventAndWaitForSessionAck } = makeMocks();
    const task = makeTask({
      callerInfo: { source: "agent", agent_id: "delegator" },
      reviewRequired: false,
      reviewState: "not_required",
    });

    await transition.finalizeExternalTask(task, { result: "delegated result" });

    expect(task.reviewState).toBe("acknowledged");
    expect(enqueueEventAndWaitForSessionAck.mock.calls[0]?.[2]).toMatchObject({
      review_state: "acknowledged",
    });
  });

  it("does not reopen an acknowledged review when finalization is retried", async () => {
    const { transition, enqueueEventAndWaitForSessionAck } = makeMocks();
    const task = makeTask({
      status: "completed",
      completedAt: new Date("2026-05-23T01:05:00.000Z"),
      terminationReason: "completed_ok",
      terminationDetail: null,
      reviewRequired: true,
      reviewState: "acknowledged",
    });

    await expect(transition.persistExecutorFinalState(task)).resolves.toBe(false);

    expect(task.reviewState).toBe("acknowledged");
    expect(enqueueEventAndWaitForSessionAck).not.toHaveBeenCalled();
  });

  it("uses pending termination hints by precedence for non-completed final states", async () => {
    const { transition, enqueueEventAndWaitForSessionAck } = makeMocks();
    const task = makeTask({
      pendingTerminationHint: "limit_hit",
      pendingTerminationDetail: "rate limit",
    });

    await transition.finalizeExternalTask(task, { error: "boom" });

    expect(task.terminationReason).toBe("limit_hit");
    expect(enqueueEventAndWaitForSessionAck.mock.calls[0]?.[2]).toMatchObject({
      status: "error",
      termination_reason: "limit_hit",
      termination_detail: "rate limit",
      review_state: "acknowledged",
    });
  });
});

describe("TaskLifecycleTransition.persistExecutorFinalState", () => {
  it("persists and broadcasts the existing final status without mutating it", async () => {
    const { transition, enqueueEventAndWaitForSessionAck } = makeMocks();
    const completedAt = new Date("2026-05-23T01:05:00.000Z");
    const task = makeTask({ status: "interrupted", completedAt });

    await expect(transition.persistExecutorFinalState(task)).resolves.toBe(true);

    expect(task.status).toBe("interrupted");
    expect(task.completedAt).toBe(completedAt);
    expect(task.terminalEventId).toBe(8);
    expect(enqueueEventAndWaitForSessionAck.mock.calls[0]?.[2]).toMatchObject({
      status: "interrupted",
      termination_reason: "unknown",
      termination_detail: null,
      review_state: "acknowledged",
    });
  });

  it("does not append another terminal effect after it was recorded", async () => {
    const { transition, enqueueEventAndWaitForSessionAck } = makeMocks();
    const task = makeTask({
      status: "completed",
      terminationReason: "completed_ok",
      terminationEventRecorded: true,
    });

    await expect(transition.persistExecutorFinalState(task)).resolves.toBe(false);

    expect(enqueueEventAndWaitForSessionAck).not.toHaveBeenCalled();
  });

  it("treats a durable terminal receipt as finalized even when a legacy reason is absent", async () => {
    const { transition, enqueueEventAndWaitForSessionAck } = makeMocks();
    const task = makeTask({
      status: "completed",
      terminationEventRecorded: true,
      terminalEventId: 41,
    });

    await expect(transition.persistExecutorFinalState(task)).resolves.toBe(false);

    expect(task.terminationReason).toBe("completed_ok");
    expect(enqueueEventAndWaitForSessionAck).not.toHaveBeenCalled();
  });
});

describe("TaskLifecycleTransition shutdown/delete interrupt helpers", () => {
  it("marks running tasks interrupted for shutdown and persists that state", async () => {
    const { transition, enqueueEventAndWaitForSessionAck } = makeMocks();
    const task = makeTask();
    const shutdownAt = new Date("2026-05-23T01:10:00.000Z");

    await transition.markRunningTaskInterruptedForShutdown(task, shutdownAt);

    expect(task.status).toBe("interrupted");
    expect(task.completedAt).toBe(shutdownAt);
    expect(enqueueEventAndWaitForSessionAck.mock.calls[0]?.[2]).toMatchObject({
      status: "interrupted",
      termination_reason: "killed",
      termination_detail: "shutdown",
      review_state: "acknowledged",
    });
  });

  it("does not mutate terminal tasks during shutdown interrupt preparation", async () => {
    const { transition, enqueueEventAndWaitForSessionAck } = makeMocks();
    const completedAt = new Date("2026-05-23T01:05:00.000Z");
    const task = makeTask({ status: "completed", completedAt });

    await transition.markRunningTaskInterruptedForShutdown(task, new Date());

    expect(task.status).toBe("completed");
    expect(task.completedAt).toBe(completedAt);
    expect(enqueueEventAndWaitForSessionAck).not.toHaveBeenCalled();
  });

  it("delete interrupt helper waits for drain and isolates interrupt/drain failures", async () => {
    const { transition } = makeMocks();
    const task = makeTask({
      executionPromise: Promise.reject(new Error("drain rejected")),
    });
    const interrupt = vi.fn().mockRejectedValue(new Error("already closed"));
    const engine = { interrupt } as unknown as EnginePort;
    task.runner = {
      engine,
      dispatcher: new InProcessRunnerCommandDispatcher(engine),
    };

    await expect(transition.interruptAndDrain(task)).resolves.toBeUndefined();

    expect(interrupt).toHaveBeenCalledTimes(1);
  });

  it("shutdown interrupt helper lets callers collect drain without awaiting it", async () => {
    const { transition } = makeMocks();
    let releaseDrain!: () => void;
    const drain = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    const task = makeTask({ executionPromise: drain });
    const interrupt = vi.fn().mockResolvedValue(true);
    const engine = { interrupt } as unknown as EnginePort;
    task.runner = {
      engine,
      dispatcher: new InProcessRunnerCommandDispatcher(engine),
    };

    await transition.interruptForShutdown(task);
    const drainPromise = transition.getDrainPromise(task);

    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(drainPromise).toBeDefined();
    releaseDrain();
    await expect(drainPromise).resolves.toBeUndefined();
  });
});
