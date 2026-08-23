import { describe, expect, it, vi } from "vitest";

import type { Task } from "../../src/task/task_models.js";
import {
  RunnerAdoptionFailureRecovery,
  type RunnerAdoptionFailureRecoveryDeps,
} from "../../src/runner/runner_adoption_failure_recovery.js";
import type { RunnerRegistration } from "../../src/runner/runner_process_registry.js";
import type { TaskRunnerRuntime } from "../../src/runner/task_runner_runtime.js";

const NOW_MS = Date.parse("2026-08-23T06:30:00.000Z");
const LEASE_TIMEOUT_MS = 60_000;
// These cases record today's policy choices. The execution redesign may
// intentionally change them without violating a runner invariant.
const currentPolicySnapshot = it;

describe("RunnerAdoptionFailureRecovery", () => {
  it("deduplicates an active recovery and clears the slot after it settles", async () => {
    let resolveRefresh!: (value: RunnerRegistration) => void;
    const refresh = new Promise<RunnerRegistration>((resolve) => { resolveRefresh = resolve; });
    const subject = makeSubject({ refreshRegistration: vi.fn(async () => await refresh) });
    const current = registration();
    const currentTask = task();
    const completion = Promise.resolve();
    currentTask.executionPromise = completion;

    const input = recoveryInput(current, currentTask, completion);
    subject.recovery.schedule(input);
    subject.recovery.schedule(input);

    expect(subject.recovery.has("session-a")).toBe(true);
    expect(subject.recovery.pending()).toHaveLength(1);
    expect(subject.deps.refreshRegistration).toHaveBeenCalledOnce();

    resolveRefresh(current);
    await Promise.all(subject.recovery.pending());

    expect(subject.recovery.has("session-a")).toBe(false);
    expect(subject.deps.onFailure).not.toHaveBeenCalled();
  });

  currentPolicySnapshot("backs off a live runner that is not safe to replace, then clear and prune remove the gate", async () => {
    let now = NOW_MS;
    const subject = makeSubject({ now: () => now });

    await scheduleAndWait(subject.recovery, registration({ sessionId: "session-a" }), task("session-a"));
    await scheduleAndWait(subject.recovery, registration({ sessionId: "session-b" }), task("session-b"));

    expect(subject.recovery.shouldSkip("session-a")).toBe(true);
    expect(subject.recovery.shouldSkip("session-b")).toBe(true);
    subject.recovery.clear("session-a");
    subject.recovery.prune(["session-a"]);
    expect(subject.recovery.shouldSkip("session-a")).toBe(false);
    expect(subject.recovery.shouldSkip("session-b")).toBe(false);

    now += LEASE_TIMEOUT_MS;
    expect(subject.recovery.shouldSkip("unknown")).toBe(false);
  });

  it("stands down without destructive recovery when a newer runner supersedes the attempt", async () => {
    const subject = makeSubject();
    const current = registration();
    const currentTask = task();
    const rejectedAttempt = runtime();
    currentTask.runner = runtime();

    await scheduleAndWait(subject.recovery, current, currentTask, {
      ownedRunner: rejectedAttempt,
      attemptRunner: rejectedAttempt,
    });

    expect(rejectedAttempt.dispatcher.detachHost).toHaveBeenCalledOnce();
    expect(subject.deps.refreshRegistration).not.toHaveBeenCalled();
    expect(subject.deps.terminateRegistration).not.toHaveBeenCalled();
    expect(subject.deps.resumeReplacement).not.toHaveBeenCalled();
    expect(subject.deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ supersededBy: "runner" }),
      "runner adoption failure was superseded by a newer execution",
    );
  });

  it("stands down when a newer execution promise supersedes the failed attempt", async () => {
    const subject = makeSubject();
    const current = registration();
    const currentTask = task();
    const rejectedAttempt = runtime();
    const failedCompletion = Promise.resolve();
    currentTask.executionPromise = Promise.resolve();

    subject.recovery.schedule({
      ...recoveryInput(current, currentTask, failedCompletion),
      ownedRunner: rejectedAttempt,
      attemptRunner: rejectedAttempt,
    });
    await Promise.all(subject.recovery.pending());

    expect(rejectedAttempt.dispatcher.detachHost).toHaveBeenCalledOnce();
    expect(subject.deps.refreshRegistration).not.toHaveBeenCalled();
    expect(subject.deps.terminateRegistration).not.toHaveBeenCalled();
    expect(subject.deps.resumeReplacement).not.toHaveBeenCalled();
    expect(subject.deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ supersededBy: "execution" }),
      "runner adoption failure was superseded by a newer execution",
    );
  });

  it("terminalizes a refreshed dead runner and resumes a replacement", async () => {
    const dead = registration({ pidAlive: false });
    const subject = makeSubject({
      refreshRegistration: vi.fn(async () => dead),
      hydrateRegistration: vi.fn(async () => dead),
    });
    const currentTask = task();

    await scheduleAndWait(subject.recovery, registration(), currentTask);

    expect(subject.deps.terminateRegistration).not.toHaveBeenCalled();
    expect(subject.deps.markReaped).toHaveBeenCalledWith(
      dead,
      new Date(NOW_MS).toISOString(),
      { code: "runner_exited", message: "runner process exited before execution completed" },
    );
    expect(subject.deps.invalidateRegistration).toHaveBeenCalled();
    expect(subject.deps.recoverOffline).toHaveBeenCalledWith(
      expect.objectContaining({ pidAlive: false, lifecycle: expect.objectContaining({ execution_state: "reaped" }) }),
      currentTask,
    );
    expect(subject.deps.resumeReplacement).toHaveBeenCalledWith(
      currentTask,
      "runner process exited before execution completed",
      dead.config,
    );
  });

  currentPolicySnapshot("replaces a running runner when a nested cause proves its socket disappeared", async () => {
    const subject = makeSubject();
    const socketError = new Error("adoption failed", {
      cause: new Error("connect failed", {
        cause: Object.assign(new Error("missing"), { code: "ENOENT" }),
      }),
    });

    await scheduleAndWait(subject.recovery, registration(), task(), { error: socketError });

    expect(subject.deps.terminateRegistration).toHaveBeenCalledOnce();
    expect(subject.deps.resumeReplacement).toHaveBeenCalledWith(
      expect.anything(),
      "runner socket disappeared while the registered process remained alive",
      expect.anything(),
    );
  });

  currentPolicySnapshot("does not replace a prebootstrap runner merely because its socket is absent", async () => {
    const prebootstrap = registration({ lifecycleState: null });
    const subject = makeSubject();
    const socketError = Object.assign(new Error("connect ENOENT"), { code: "ENOENT" });

    await scheduleAndWait(subject.recovery, prebootstrap, task(), {
      disposition: "adopt_prebootstrap",
      error: socketError,
    });

    expect(subject.deps.terminateRegistration).not.toHaveBeenCalled();
    expect(subject.deps.resumeReplacement).not.toHaveBeenCalled();
    expect(subject.recovery.shouldSkip("session-a")).toBe(true);
  });

  currentPolicySnapshot("records refresh uncertainty through failure tracking and suppresses an immediate retry", async () => {
    const refreshFailure = new Error("registration unreadable");
    const subject = makeSubject({
      refreshRegistration: vi.fn(async () => { throw refreshFailure; }),
    });
    const current = registration();

    await scheduleAndWait(subject.recovery, current, task());

    expect(subject.deps.onFailure).toHaveBeenCalledWith(current, "adopt_running", refreshFailure);
    expect(subject.recovery.shouldSkip("session-a")).toBe(true);
    expect(subject.deps.terminateRegistration).not.toHaveBeenCalled();
  });

  it("invalidates a lifecycle-free failed attempt without inventing durable reaped history", async () => {
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
    expect(subject.deps.resumeReplacement).toHaveBeenCalledWith(
      currentTask,
      "provisional runner exited",
      provisional.config,
    );
  });

  it.skip("불변식 7·15: stopped recovery는 canonical terminal transition으로 실행 전체를 정산한다", async () => {
    const dead = registration({ pidAlive: false });
    const subject = makeSubject({
      refreshRegistration: vi.fn(async () => dead),
      hydrateRegistration: vi.fn(async () => dead),
    });
    const currentTask = task() as Task & { execution?: unknown };
    currentTask.execution = { phase: "active" };
    const attempt = runtime();
    const completion = Promise.resolve();
    currentTask.runner = attempt;
    currentTask.executionPromise = completion;

    await scheduleAndWait(subject.recovery, registration(), currentTask, {
      ownedRunner: attempt,
      attemptRunner: attempt,
      completion,
    });

    expect(attempt.dispatcher.detachHost).toHaveBeenCalledOnce();
    expect(subject.deps.recoverOffline).toHaveBeenCalledOnce();
    expect(subject.deps.resumeReplacement).toHaveBeenCalledOnce();
    // Terminal settlement owns the whole execution slot. It does not preserve
    // legacy runner/promise fields as evidence that cleanup was avoided.
    expect(currentTask.execution).toBeUndefined();
  });
});

function makeSubject(overrides: Partial<RunnerAdoptionFailureRecoveryDeps> = {}) {
  const deps = {
    leaseTimeoutMs: LEASE_TIMEOUT_MS,
    logger: { info: vi.fn(), warn: vi.fn() },
    now: () => NOW_MS,
    refreshRegistration: vi.fn(async (value: RunnerRegistration) => value),
    hydrateRegistration: vi.fn(async (value: RunnerRegistration) => value),
    terminateRegistration: vi.fn(async () => {}),
    invalidateRegistration: vi.fn(async () => {}),
    markReaped: vi.fn(async () => {}),
    recoverOffline: vi.fn(async (_registration: RunnerRegistration, recoveredTask: Task) => recoveredTask),
    resumeReplacement: vi.fn(async () => {}),
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

function recoveryInput(
  current: RunnerRegistration,
  currentTask: Task,
  completion: Promise<void>,
) {
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
  sessionId?: string;
  pidAlive?: boolean;
  lifecycleState?: "running" | "completed" | "failed" | "reaped" | "closed" | null;
} = {}): RunnerRegistration {
  const sessionId = options.sessionId ?? "session-a";
  const lifecycleState = options.lifecycleState === undefined ? "running" : options.lifecycleState;
  return {
    config: {
      sessionId,
      codeSha: "sha-a",
      claudeRuntimeTurnTimeoutMs: LEASE_TIMEOUT_MS,
      agent: { id: "agent-a", name: "Agent A" },
      paths: {
        sessionDirectory: `/runner/${sessionId}`,
        socketPath: `/runner/${sessionId}/runner.sock`,
      },
    } as RunnerRegistration["config"],
    pid: 4123,
    pidAlive: options.pidAlive ?? true,
    registeredAtMs: NOW_MS - 1_000,
    bootstrap: null,
    lifecycle: lifecycleState === null ? null : {
      session_id: sessionId,
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

function task(sessionId = "session-a"): Task {
  return {
    agentSessionId: sessionId,
    prompt: "continue",
    status: "running",
    createdAt: new Date(NOW_MS - 10_000),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
  };
}
