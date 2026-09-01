import { describe, expect, it, vi } from "vitest";

import type { Task } from "../../src/task/task_models.js";
import {
  RunnerAdoptionFailureRecovery,
  type RunnerAdoptionFailureRecoveryDeps,
} from "../../src/runner/runner_adoption_failure_recovery.js";
import type { RunnerRegistration } from "../../src/runner/runner_process_registry.js";
import type { TaskRunnerRuntime } from "../../src/runner/task_runner_runtime.js";

const NOW_MS = Date.parse("2026-08-23T06:30:00.000Z");

describe("RunnerAdoptionFailureRecovery", () => {
  it("deduplicates active recovery and clears the slot after settlement", async () => {
    let resolveRefresh!: (value: RunnerRegistration) => void;
    const refresh = new Promise<RunnerRegistration>((resolve) => { resolveRefresh = resolve; });
    const subject = makeSubject({ refreshRegistration: vi.fn(async () => await refresh) });
    const input = recoveryInput(registration(), task());
    subject.recovery.schedule(input);
    subject.recovery.schedule(input);
    expect(subject.recovery.pending()).toHaveLength(1);
    resolveRefresh(input.registration);
    await Promise.all(subject.recovery.pending());
    expect(subject.recovery.has("session-a")).toBe(false);
  });

  it("stands down when a newer runner supersedes the failed attempt", async () => {
    const subject = makeSubject();
    const currentTask = task();
    const rejected = runtime();
    currentTask.runner = runtime();
    await scheduleAndWait(subject.recovery, registration(), currentTask, {
      ownedRunner: rejected,
      attemptRunner: rejected,
    });
    expect(rejected.dispatcher.detachHost).toHaveBeenCalledOnce();
    expect(subject.deps.terminateRegistration).not.toHaveBeenCalled();
    expect(subject.deps.markFailure).not.toHaveBeenCalled();
  });

  it("replays a refreshed dead runner terminal fact without replacement", async () => {
    const dead = registration({ pidAlive: false });
    const subject = makeSubject({
      refreshRegistration: vi.fn(async () => dead),
      hydrateRegistration: vi.fn(async () => dead),
    });
    const currentTask = task();
    await scheduleAndWait(subject.recovery, registration(), currentTask);
    expect(subject.deps.markReaped).toHaveBeenCalledWith(
      dead,
      new Date(NOW_MS).toISOString(),
      { code: "runner_exited", message: "runner process exited before execution completed" },
    );
    expect(subject.deps.recoverOffline).toHaveBeenCalledWith(
      expect.objectContaining({
        pidAlive: false,
        lifecycle: expect.objectContaining({ execution_state: "reaped" }),
      }),
      currentTask,
    );
    expect(subject.deps.markFailure).not.toHaveBeenCalled();
  });

  it("terminalizes a lifecycle-free dead attempt exactly once", async () => {
    const subject = makeSubject();
    const provisional = registration({ lifecycleState: null, pidAlive: false });
    const currentTask = task();
    await subject.recovery.terminalize(
      provisional,
      currentTask,
      { code: "runner_exited", message: "provisional runner exited" },
      "reap_dead",
    );
    expect(subject.deps.markReaped).not.toHaveBeenCalled();
    expect(subject.deps.recoverOffline).not.toHaveBeenCalled();
    expect(subject.deps.invalidateRegistration).toHaveBeenCalledWith(provisional);
    expect(subject.deps.markFailure).toHaveBeenCalledWith(
      currentTask,
      "provisional runner exited",
    );
  });

  it("defers a live prebootstrap runner whose socket has not appeared", async () => {
    const subject = makeSubject();
    const prebootstrap = registration({ lifecycleState: null });
    await scheduleAndWait(subject.recovery, prebootstrap, task(), {
      disposition: "adopt_prebootstrap",
      error: Object.assign(new Error("connect ENOENT"), { code: "ENOENT" }),
    });
    expect(subject.deps.terminateRegistration).not.toHaveBeenCalled();
    expect(subject.deps.markFailure).not.toHaveBeenCalled();
    expect(subject.recovery.shouldSkip("session-a")).toBe(true);
  });
});

function makeSubject(overrides: Partial<RunnerAdoptionFailureRecoveryDeps> = {}) {
  const deps = {
    leaseTimeoutMs: 60_000,
    logger: { info: vi.fn(), warn: vi.fn() },
    now: () => NOW_MS,
    refreshRegistration: vi.fn(async (value: RunnerRegistration) => value),
    hydrateRegistration: vi.fn(async (value: RunnerRegistration) => value),
    terminateRegistration: vi.fn(async () => {}),
    invalidateRegistration: vi.fn(async () => {}),
    markReaped: vi.fn(async () => {}),
    recoverOffline: vi.fn(async (_registration: RunnerRegistration, recoveredTask: Task) => recoveredTask),
    markFailure: vi.fn(async () => {}),
    onFailure: vi.fn(),
    ...overrides,
  } as RunnerAdoptionFailureRecoveryDeps;
  return { deps, recovery: new RunnerAdoptionFailureRecovery(deps) };
}

async function scheduleAndWait(
  recovery: RunnerAdoptionFailureRecovery,
  current: RunnerRegistration,
  currentTask: Task,
  overrides: Partial<Parameters<RunnerAdoptionFailureRecovery["schedule"]>[0]> = {},
): Promise<void> {
  const completion = overrides.completion ?? Promise.resolve();
  currentTask.executionPromise = completion;
  recovery.schedule({
    registration: current,
    disposition: current.lifecycle ? "adopt_running" : "adopt_prebootstrap",
    task: currentTask,
    completion,
    ownedRunner: undefined,
    attemptRunner: undefined,
    error: new Error("adoption failed"),
    ...overrides,
  });
  await Promise.all(recovery.pending());
}

function recoveryInput(current: RunnerRegistration, currentTask: Task) {
  const completion = Promise.resolve();
  currentTask.executionPromise = completion;
  return {
    registration: current,
    disposition: "adopt_running" as const,
    task: currentTask,
    completion,
    ownedRunner: undefined,
    attemptRunner: undefined,
    error: new Error("adoption failed"),
  };
}

function runtime(): TaskRunnerRuntime {
  return {
    dispatcher: { detachHost: vi.fn(async () => {}) },
    engine: {},
    eventPersistence: "runner",
  } as unknown as TaskRunnerRuntime;
}

function registration(options: {
  pidAlive?: boolean;
  lifecycleState?: "running" | "completed" | "failed" | "reaped" | "closed" | null;
} = {}): RunnerRegistration {
  const lifecycleState = options.lifecycleState === undefined ? "running" : options.lifecycleState;
  return {
    config: {
      sessionId: "session-a",
      codeSha: "sha-a",
      claudeRuntimeTurnTimeoutMs: 60_000,
      agent: { id: "agent-a", name: "Agent A" },
      paths: {
        sessionDirectory: "/runner/session-a",
        socketPath: "/runner/session-a/runner.sock",
      },
    } as RunnerRegistration["config"],
    pid: 4123,
    pidAlive: options.pidAlive ?? true,
    registeredAtMs: NOW_MS - 1_000,
    bootstrap: null,
    lifecycle: lifecycleState === null ? null : {
      session_id: "session-a",
      runner_pid: 4123,
      execution_command_id: "execute-a",
      execution_state: lifecycleState,
      progress_seq: 1,
      progress_at: new Date(NOW_MS - 1_000).toISOString(),
      liveness_at: new Date(NOW_MS - 1_000).toISOString(),
      in_flight_tools: [],
      terminal_error: null,
    },
    registrationId: "registration-a",
    pidStartIdentity: "start-4123",
  };
}

function task(): Task {
  return {
    agentSessionId: "session-a",
    prompt: "continue",
    status: "running",
    createdAt: new Date(NOW_MS - 10_000),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
  };
}
