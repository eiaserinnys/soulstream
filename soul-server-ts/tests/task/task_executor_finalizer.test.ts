import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import type { EnginePort } from "../../src/engine/protocol.js";
import { TaskExecutorFinalizer } from "../../src/task/task_executor_finalizer.js";
import type { Task } from "../../src/task/task_models.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "sess-1",
    prompt: "hi",
    status: "completed",
    createdAt: new Date("2026-05-23T01:00:00.000Z"),
    completedAt: new Date("2026-05-23T01:05:00.000Z"),
    lastEventId: 7,
    lastReadEventId: 0,
    interventionQueue: [],
    ...overrides,
  };
}

function makeLogger(): Logger {
  return { warn: vi.fn() } as unknown as Logger;
}

function makeEngine(close: () => Promise<void>): EnginePort {
  return {
    backendId: "codex",
    workspaceDir: "/tmp/codex-default",
    async *execute() {},
    async interrupt() { return true; },
    close,
  };
}

describe("TaskExecutorFinalizer.finalize", () => {
  it("persists final state, closes engine, clears engine, then notifies caller", async () => {
    const calls: string[] = [];
    const persistExecutorFinalState = vi.fn(async (task: Task) => {
      calls.push(`persist:${task.engine ? "engine" : "no-engine"}`);
    });
    const close = vi.fn(async () => {
      calls.push("close");
    });
    const notify = vi.fn(async (task: Task) => {
      calls.push(`notify:${task.engine ? "engine" : "no-engine"}`);
    });
    const finalizer = new TaskExecutorFinalizer({
      lifecycleTransition: { persistExecutorFinalState },
      logger: makeLogger(),
      completionNotifier: { notify },
    });
    const task = makeTask({ callerSessionId: "parent-sess-1" });
    task.engine = makeEngine(close);

    await finalizer.finalize(task);

    expect(calls).toEqual(["persist:engine", "close", "notify:no-engine"]);
    expect(persistExecutorFinalState).toHaveBeenCalledWith(task);
    expect(close).toHaveBeenCalledTimes(1);
    expect(task.engine).toBeUndefined();
    expect(notify).toHaveBeenCalledWith(task);
  });

  it("isolates engine close failure and still clears engine before notification", async () => {
    const persistExecutorFinalState = vi.fn(async () => undefined);
    const close = vi.fn().mockRejectedValue(new Error("close boom"));
    const notify = vi.fn(async (task: Task) => {
      expect(task.engine).toBeUndefined();
    });
    const logger = makeLogger();
    const finalizer = new TaskExecutorFinalizer({
      lifecycleTransition: { persistExecutorFinalState },
      logger,
      completionNotifier: { notify },
    });
    const task = makeTask({ callerSessionId: "parent-sess-1" });
    task.engine = makeEngine(close);

    await expect(finalizer.finalize(task)).resolves.toBeUndefined();

    expect(close).toHaveBeenCalledTimes(1);
    expect(task.engine).toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { err: expect.any(Error), sessionId: "sess-1" },
      "engine.close failed",
    );
  });

  it("isolates completion notifier failure after final-state persistence and engine cleanup", async () => {
    const persistExecutorFinalState = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const notify = vi.fn().mockRejectedValue(new Error("notify boom"));
    const logger = makeLogger();
    const finalizer = new TaskExecutorFinalizer({
      lifecycleTransition: { persistExecutorFinalState },
      logger,
      completionNotifier: { notify },
    });
    const task = makeTask({ callerSessionId: "parent-sess-1" });
    task.engine = makeEngine(close);

    await expect(finalizer.finalize(task)).resolves.toBeUndefined();

    expect(persistExecutorFinalState).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(task.engine).toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { err: expect.any(Error), sessionId: "sess-1" },
      "completionNotifier.notify threw (should not happen — notifier is supposed to isolate)",
    );
  });

  it("지연 runtime follow-up이 예약된 중간 종료는 caller 완료로 통지하지 않는다", async () => {
    const persistExecutorFinalState = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const notify = vi.fn(async () => undefined);
    const finalizer = new TaskExecutorFinalizer({
      lifecycleTransition: { persistExecutorFinalState },
      logger: makeLogger(),
      completionNotifier: { notify },
    });
    const task = makeTask({
      callerSessionId: "parent-sess-1",
      pendingClaudeRuntimeFollowupRetry: true,
    });
    task.engine = makeEngine(close);

    await finalizer.finalize(task);

    expect(persistExecutorFinalState).toHaveBeenCalledWith(task);
    expect(close).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });
});
