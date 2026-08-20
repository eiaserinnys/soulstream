import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import type { EnginePort } from "../../src/engine/protocol.js";
import { InProcessRunnerCommandDispatcher } from
  "../../src/runner/runner_command_dispatcher.js";
import { RunnerProcessEngineProxy } from
  "../../src/runner/runner_process_engine_proxy.js";
import {
  createInProcessTaskRunnerRuntime,
  createTaskRunnerRuntime,
} from "../../src/runner/task_runner_runtime.js";
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
  it("retains the Claude runner owner while its persistent runtime has background work", async () => {
    const close = vi.fn(async () => undefined);
    const engine = {
      ...makeEngine(close),
      backendId: "claude",
      detachedClaudeRuntime: true,
      detachedClaudeRuntimeActivity: vi.fn(async () => ({
        foregroundPhase: "post_result_drain",
        queryLifecycle: "open",
        backgroundTaskCount: 2,
        pendingInputRequestCount: 0,
        pendingRuntimeSignalCount: 0,
      })),
    } as EnginePort;
    const task = makeTask({ runner: createInProcessTaskRunnerRuntime(engine) });
    const finalizer = new TaskExecutorFinalizer({
      lifecycleTransition: {
        persistExecutorFinalState: vi.fn().mockResolvedValue({
          newlyFinalized: true,
          terminalTransitionApplied: true,
        }),
      },
      logger: makeLogger(),
    });

    await finalizer.finalize(task);

    expect(close).not.toHaveBeenCalled();
    expect(task.runner?.engine).toBe(engine);
    expect(task.runnerRetainedForClaudeBackground).toBe(true);
  });

  /**
   * 260820 incident: a terminal runner whose process had exited was replayed
   * offline, and the finalizer then retained that dead handle for background
   * work. `task.runner` stayed set forever and `startExecution` refuses to run
   * while a runner is attached, so the session could never take another turn.
   */
  it("never retains an offline replay handle, which has no live child to keep", async () => {
    const close = vi.fn(async () => undefined);
    const detachedClaudeRuntimeActivity = vi.fn(async () => ({
      foregroundPhase: "post_result_drain",
      queryLifecycle: "open",
      backgroundTaskCount: 2,
      pendingInputRequestCount: 0,
      pendingRuntimeSignalCount: 0,
    }));
    const engine = {
      ...makeEngine(close),
      backendId: "claude",
      detachedClaudeRuntime: true,
      detachedClaudeRuntimeActivity,
    } as EnginePort;
    const task = makeTask({ runner: createInProcessTaskRunnerRuntime(engine) });
    task.runnerIsOfflineReplay = true;
    const finalizer = new TaskExecutorFinalizer({
      lifecycleTransition: {
        persistExecutorFinalState: vi.fn().mockResolvedValue({
          newlyFinalized: true,
          terminalTransitionApplied: true,
        }),
      },
      logger: makeLogger(),
    });

    await finalizer.finalize(task);

    expect(task.runner).toBeUndefined();
    expect(task.runnerRetainedForClaudeBackground).toBeUndefined();
    expect(task.runnerIsOfflineReplay).toBeUndefined();
    expect(close).toHaveBeenCalled();
  });

  /**
   * The flag travels with the attachment, so a live runner attached after an
   * offline replay must not inherit it — otherwise retention would be skipped
   * for a runner that really does own live background work.
   */
  it("retains a live runner attached after an earlier offline replay", async () => {
    const close = vi.fn(async () => undefined);
    const engine = {
      ...makeEngine(close),
      backendId: "claude",
      detachedClaudeRuntime: true,
      detachedClaudeRuntimeActivity: vi.fn(async () => ({
        foregroundPhase: "post_result_drain",
        queryLifecycle: "open",
        backgroundTaskCount: 1,
        pendingInputRequestCount: 0,
        pendingRuntimeSignalCount: 0,
      })),
    } as EnginePort;
    const task = makeTask({ runner: createInProcessTaskRunnerRuntime(engine) });
    task.runnerIsOfflineReplay = false;
    const finalizer = new TaskExecutorFinalizer({
      lifecycleTransition: {
        persistExecutorFinalState: vi.fn().mockResolvedValue({
          newlyFinalized: true,
          terminalTransitionApplied: true,
        }),
      },
      logger: makeLogger(),
    });

    await finalizer.finalize(task);

    expect(close).not.toHaveBeenCalled();
    expect(task.runnerRetainedForClaudeBackground).toBe(true);
  });

  it("closes a detached Claude runner immediately when the owner has no background work", async () => {
    const close = vi.fn(async () => undefined);
    const engine = {
      ...makeEngine(close),
      backendId: "claude",
      detachedClaudeRuntime: true,
      detachedClaudeRuntimeActivity: vi.fn(async () => ({
        foregroundPhase: "post_result_drain",
        queryLifecycle: "open",
        backgroundTaskCount: 0,
        pendingInputRequestCount: 0,
        pendingRuntimeSignalCount: 0,
      })),
    } as EnginePort;
    const task = makeTask({ runner: createInProcessTaskRunnerRuntime(engine) });
    const finalizer = new TaskExecutorFinalizer({
      lifecycleTransition: {
        persistExecutorFinalState: vi.fn().mockResolvedValue({
          newlyFinalized: true,
          terminalTransitionApplied: true,
        }),
      },
      logger: makeLogger(),
    });

    await finalizer.finalize(task);

    expect(close).toHaveBeenCalledOnce();
    expect(task.runner).toBeUndefined();
    expect(task.runnerRetainedForClaudeBackground).toBeUndefined();
  });

  it.each([
    ["not_supported", { status: "not_supported" }],
    ["undefined", undefined],
  ])("closes a pre-contract Claude runner whose activity is %s", async (_label, result) => {
    const close = vi.fn(async () => undefined);
    const childDispatcher = {
      invoke: vi.fn().mockResolvedValue(result),
      close,
    };
    const engine = new RunnerProcessEngineProxy(
      "claude",
      "/workspace/a",
      childDispatcher as never,
    );
    const task = makeTask({ runner: createInProcessTaskRunnerRuntime(engine) });
    const finalizer = new TaskExecutorFinalizer({
      lifecycleTransition: {
        persistExecutorFinalState: vi.fn().mockResolvedValue({
          newlyFinalized: true,
          terminalTransitionApplied: true,
        }),
      },
      logger: makeLogger(),
    });

    await finalizer.finalize(task);

    expect(close).toHaveBeenCalledOnce();
    expect(task.runner).toBeUndefined();
    expect(task.runnerRetainedForClaudeBackground).toBeUndefined();
  });

  it("releases a retained runner after its detached runtime becomes idle", async () => {
    const close = vi.fn(async () => undefined);
    const engine = {
      ...makeEngine(close),
      backendId: "claude",
      detachedClaudeRuntime: true,
      detachedClaudeRuntimeActivity: vi.fn(async () => ({
        foregroundPhase: "post_result_drain",
        queryLifecycle: "open",
        backgroundTaskCount: 0,
        pendingInputRequestCount: 0,
        pendingRuntimeSignalCount: 0,
      })),
    } as EnginePort;
    const task = makeTask({
      runner: createInProcessTaskRunnerRuntime(engine),
      runnerRetainedForClaudeBackground: true,
    });
    const finalizer = new TaskExecutorFinalizer({
      lifecycleTransition: {
        persistExecutorFinalState: vi.fn().mockResolvedValue({
          newlyFinalized: false,
          terminalTransitionApplied: false,
        }),
      },
      logger: makeLogger(),
    });

    await finalizer.releaseRetainedClaudeRunner(task);

    expect(close).toHaveBeenCalledOnce();
    expect(task.runner).toBeUndefined();
    expect(task.runnerRetainedForClaudeBackground).toBeUndefined();
  });

  it("rejects runner configuration without a command dispatcher", () => {
    const engine = makeEngine(vi.fn().mockResolvedValue(undefined));

    expect(() => createTaskRunnerRuntime(engine, undefined as never)).toThrow(
      "Task runner command dispatcher is required",
    );
  });

  it("persists final state, closes runner, clears runner, then notifies caller", async () => {
    const calls: string[] = [];
    const persistExecutorFinalState = vi.fn(async (task: Task) => {
      calls.push(`persist:${task.runner ? "runner" : "no-runner"}`);
      return { newlyFinalized: true, terminalTransitionApplied: true };
    });
    const close = vi.fn(async () => {
      calls.push("close");
    });
    const notify = vi.fn(async (task: Task) => {
      calls.push(`notify:${task.runner ? "runner" : "no-runner"}`);
    });
    const finalizer = new TaskExecutorFinalizer({
      lifecycleTransition: { persistExecutorFinalState },
      logger: makeLogger(),
      completionNotifier: { notify },
    });
    const task = makeTask({ callerSessionId: "parent-sess-1" });
    task.runner = createInProcessTaskRunnerRuntime(makeEngine(close));

    await finalizer.finalize(task);

    expect(calls).toEqual(["persist:runner", "close", "notify:no-runner"]);
    expect(persistExecutorFinalState).toHaveBeenCalledWith(task);
    expect(close).toHaveBeenCalledTimes(1);
    expect(task.runner).toBeUndefined();
    expect(notify).toHaveBeenCalledWith(task);
  });

  it("releases the runner even when final-state persistence fails", async () => {
    const close = vi.fn(async () => undefined);
    const notify = vi.fn();
    const finalizer = new TaskExecutorFinalizer({
      lifecycleTransition: {
        persistExecutorFinalState: vi.fn().mockRejectedValue(new Error("persist boom")),
      },
      logger: makeLogger(),
      completionNotifier: { notify },
    });
    const task = makeTask({ callerSessionId: "parent-sess-1" });
    task.runner = createInProcessTaskRunnerRuntime(makeEngine(close));

    await expect(finalizer.finalize(task)).rejects.toThrow("persist boom");

    expect(close).toHaveBeenCalledOnce();
    expect(task.runner).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });

  it("does not notify completion when persistence observes an existing terminal transition", async () => {
    const notify = vi.fn();
    const finalizer = new TaskExecutorFinalizer({
      lifecycleTransition: {
        persistExecutorFinalState: vi.fn().mockResolvedValue({
          newlyFinalized: false,
          terminalTransitionApplied: false,
        }),
      },
      logger: makeLogger(),
      completionNotifier: { notify },
    });

    await finalizer.finalize(makeTask({
      callerSessionId: "parent-sess-1",
      terminationReason: "completed_ok",
      terminationEventRecorded: true,
      terminalEventId: 7,
    }));

    expect(notify).not.toHaveBeenCalled();
  });

  it("does not notify completion when a new local finalization loses the terminal CAS", async () => {
    const notify = vi.fn();
    const finalizer = new TaskExecutorFinalizer({
      lifecycleTransition: {
        persistExecutorFinalState: vi.fn().mockResolvedValue({
          newlyFinalized: true,
          terminalTransitionApplied: false,
        }),
      },
      logger: makeLogger(),
      completionNotifier: { notify },
    });

    await finalizer.finalize(makeTask({ callerSessionId: "parent-sess-1" }));

    expect(notify).not.toHaveBeenCalled();
  });

  it("routes production cleanup through a close command ACK", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const engine = makeEngine(close);
    const runnerCommandDispatcher = new InProcessRunnerCommandDispatcher(engine);
    const dispatch = vi.spyOn(runnerCommandDispatcher, "dispatch");
    const finalizer = new TaskExecutorFinalizer({
      lifecycleTransition: {
        persistExecutorFinalState: vi.fn().mockResolvedValue({
          newlyFinalized: false,
          terminalTransitionApplied: false,
        }),
      },
      logger: makeLogger(),
    });
    const task = makeTask({
      runner: createTaskRunnerRuntime(engine, runnerCommandDispatcher),
    });

    await finalizer.finalize(task);

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      channel: "command",
      kind: "close",
      commandId: expect.any(String),
    }));
    expect(close).toHaveBeenCalledOnce();
    expect(task.runner).toBeUndefined();
  });

  it("isolates engine close failure and still clears engine before notification", async () => {
    const persistExecutorFinalState = vi.fn(async () => ({
      newlyFinalized: true,
      terminalTransitionApplied: true,
    }));
    const close = vi.fn().mockRejectedValue(new Error("close boom"));
    const notify = vi.fn(async (task: Task) => {
      expect(task.runner).toBeUndefined();
    });
    const logger = makeLogger();
    const finalizer = new TaskExecutorFinalizer({
      lifecycleTransition: { persistExecutorFinalState },
      logger,
      completionNotifier: { notify },
    });
    const task = makeTask({ callerSessionId: "parent-sess-1" });
    task.runner = createInProcessTaskRunnerRuntime(makeEngine(close));

    await expect(finalizer.finalize(task)).resolves.toBeUndefined();

    expect(close).toHaveBeenCalledTimes(1);
    expect(task.runner).toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { err: expect.any(Error), sessionId: "sess-1" },
      "engine.close failed",
    );
  });

  it("isolates completion notifier failure after final-state persistence and engine cleanup", async () => {
    const persistExecutorFinalState = vi.fn(async () => ({
      newlyFinalized: true,
      terminalTransitionApplied: true,
    }));
    const close = vi.fn(async () => undefined);
    const notify = vi.fn().mockRejectedValue(new Error("notify boom"));
    const logger = makeLogger();
    const finalizer = new TaskExecutorFinalizer({
      lifecycleTransition: { persistExecutorFinalState },
      logger,
      completionNotifier: { notify },
    });
    const task = makeTask({ callerSessionId: "parent-sess-1" });
    task.runner = createInProcessTaskRunnerRuntime(makeEngine(close));

    await expect(finalizer.finalize(task)).resolves.toBeUndefined();

    expect(persistExecutorFinalState).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(task.runner).toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { err: expect.any(Error), sessionId: "sess-1" },
      "completionNotifier.notify threw (should not happen — notifier is supposed to isolate)",
    );
  });

  it("지연 runtime follow-up이 예약된 중간 종료는 caller 완료로 통지하지 않는다", async () => {
    const persistExecutorFinalState = vi.fn(async () => ({
      newlyFinalized: true,
      terminalTransitionApplied: true,
    }));
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
    task.runner = createInProcessTaskRunnerRuntime(makeEngine(close));

    await finalizer.finalize(task);

    expect(persistExecutorFinalState).toHaveBeenCalledWith(task);
    expect(close).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });
});
