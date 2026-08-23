import { describe, expect, it, vi } from "vitest";

import { ExecutionOwnershipConflictError } from "../../src/task/execution_ownership.js";
import type { ExecutionOwnershipBackoff } from "../../src/task/execution_ownership_backoff.js";
import type { Task } from "../../src/task/task_models.js";
import type { RunnerRegistration, RunnerRecoveryDisposition } from "../../src/runner/runner_process_registry.js";
import {
  contendsForExecutionOwnership,
  dispositionRequiresTask,
  handleRecoveryWithFailureTracking,
  reapAndResumeRunner,
  recoverRunnerByDisposition,
  resumeReapedRunner,
} from "../../src/runner/runner_recovery_disposition.js";
import type { RunnerRecoveryLogger } from "../../src/runner/runner_recovery_logging.js";

// These cases record today's policy choices. The execution redesign may
// intentionally change them without violating a runner invariant.
const currentPolicySnapshot = it;

// P2 RED marker: this one-way `satisfies` only validates the ten values listed
// here. Adding an eleventh union member does not make this test inventory fail
// to compile. Redesign 2-3 must make the product's
// `Record<RunnerRecoveryDisposition, DispositionPolicy>` the exhaustive source.
const ALL_DISPOSITIONS = [
  "wait_for_bootstrap",
  "adopt_prebootstrap",
  "adopt_running",
  "replay_terminal",
  "replay_terminal_dead",
  "retired_terminal",
  "reap_dead",
  "reap_stalled",
  "already_reaped",
  "closed",
] as const satisfies readonly RunnerRecoveryDisposition[];

describe("runner recovery disposition inventory", () => {
  currentPolicySnapshot.each(ALL_DISPOSITIONS)("declares whether %s requires a hydrated task", (disposition) => {
    expect(dispositionRequiresTask(disposition)).toBe(
      disposition !== "wait_for_bootstrap" && disposition !== "retired_terminal",
    );
  });

  currentPolicySnapshot.each(ALL_DISPOSITIONS)("declares whether %s contends for ownership", (disposition) => {
    expect(contendsForExecutionOwnership(disposition)).toBe(
      disposition === "adopt_prebootstrap"
      || disposition === "adopt_running"
      || disposition === "already_reaped",
    );
  });
});

describe("handleRecoveryWithFailureTracking", () => {
  it("clears failure and ownership backoff after a contending recovery succeeds", async () => {
    const subject = failureTrackingSubject();

    await handleRecoveryWithFailureTracking({
      ...subject.input,
      disposition: "adopt_running",
    });

    expect(subject.handle).toHaveBeenCalledOnce();
    expect(subject.clearFailure).toHaveBeenCalledWith("session-a");
    expect(subject.clearBackoff).toHaveBeenCalledWith("session-a");
  });

  it("does not clear ownership backoff for a non-contending recovery", async () => {
    const subject = failureTrackingSubject();

    await handleRecoveryWithFailureTracking({
      ...subject.input,
      disposition: "replay_terminal",
    });

    expect(subject.clearFailure).toHaveBeenCalledWith("session-a");
    expect(subject.clearBackoff).not.toHaveBeenCalled();
  });

  it("turns ownership conflicts into the shared retry observation", async () => {
    const retryAt = "2026-08-23T06:30:00.000Z";
    const subject = failureTrackingSubject({
      handle: vi.fn(async () => {
        throw new ExecutionOwnershipConflictError("session-a", retryAt, "active");
      }),
    });

    await handleRecoveryWithFailureTracking(subject.input);

    expect(subject.observeConflict).toHaveBeenCalledWith("session-a", retryAt);
    expect(subject.recordFailure).not.toHaveBeenCalled();
  });

  it("records non-ownership failures against the exact disposition", async () => {
    const failure = new Error("recovery failed");
    const subject = failureTrackingSubject({
      handle: vi.fn(async () => { throw failure; }),
    });

    await handleRecoveryWithFailureTracking({
      ...subject.input,
      disposition: "replay_terminal_dead",
    });

    expect(subject.recordFailure).toHaveBeenCalledWith(
      subject.input.registration,
      "replay_terminal_dead",
      failure,
    );
    expect(subject.observeConflict).not.toHaveBeenCalled();
  });
});

describe("resumeReapedRunner", () => {
  it("makes the reaped terminal lifecycle observable through offline recovery and replacement", async () => {
    const order: string[] = [];
    const inputTask = task();
    const input = {
      registration: registration({ pidAlive: true, lifecycleState: "reaped" }),
      task: inputTask,
      hydrate: vi.fn(async (value: RunnerRegistration) => value),
      terminate: vi.fn(async () => { order.push("terminate"); }),
      invalidate: vi.fn(async () => { order.push("invalidate"); }),
      recoverOffline: vi.fn(async (_registration: RunnerRegistration, recoveredTask: Task) => {
        order.push("recover");
        return recoveredTask;
      }),
      resumeReplacement: vi.fn(async () => { order.push("resume"); }),
      logger: { info: vi.fn() },
    };

    await resumeReapedRunner(input);

    expect(order).toEqual(["terminate", "invalidate", "recover", "resume"]);
    expect(input.recoverOffline).toHaveBeenCalledWith(
      expect.objectContaining({
        pidAlive: false,
        lifecycle: expect.objectContaining({
          execution_state: "reaped",
          terminal_error: expect.objectContaining({ message: "terminal failure" }),
        }),
      }),
      inputTask,
    );
    expect(input.resumeReplacement).toHaveBeenCalledWith(
      inputTask,
      "terminal failure",
      input.registration.config,
    );
    expect(input.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ disposition: "already_reaped" }),
      "reaped runner recovery resumed",
    );
  });

  it("does not signal a process that is already dead", async () => {
    const terminate = vi.fn(async () => {});

    await resumeReapedRunner({
      registration: registration({ pidAlive: false, lifecycleState: "reaped" }),
      task: task(),
      hydrate: async (value) => value,
      terminate,
      invalidate: async () => {},
      recoverOffline: async (_registration, recoveredTask) => recoveredTask,
      resumeReplacement: async () => {},
      logger: { info: vi.fn() },
    });

    expect(terminate).not.toHaveBeenCalled();
  });

  it.skip("불변식 16: offline recovery가 반환한 canonical task를 후속 단계가 사용한다", async () => {
    const inputTask = task("session-a");
    const canonicalTask = task("session-a");
    canonicalTask.status = "interrupted";
    const resumeReplacement = vi.fn(async () => {});

    await resumeReapedRunner({
      registration: registration({ pidAlive: false, lifecycleState: "reaped" }),
      task: inputTask,
      hydrate: async (value) => value,
      terminate: async () => {},
      invalidate: async () => {},
      recoverOffline: async () => canonicalTask,
      resumeReplacement,
      logger: { info: vi.fn() },
    });

    // 현재 구현은 recoverOffline 반환값을 버리고 inputTask를 재개한다.
    expect(resumeReplacement).toHaveBeenCalledWith(
      canonicalTask,
      expect.any(String),
      expect.anything(),
    );
  });
});

describe("reapAndResumeRunner", () => {
  it.each([
    ["reap_dead", "runner_exited", "runner process exited before execution completed"],
    ["reap_stalled", "lease_expired", "runner progress lease expired"],
  ] as const)("terminalizes a still-verified %s runner", async (disposition, code, message) => {
    const terminalize = vi.fn(async () => {});
    const current = registration({
      pidAlive: disposition === "reap_stalled",
      lifecycleState: "running",
      progressedAt: disposition === "reap_stalled"
        ? "2026-08-23T05:00:00.000Z"
        : "2026-08-23T06:29:50.000Z",
    });

    await reapAndResumeRunner({
      registration: current,
      disposition,
      task: task(),
      hydrate: async (value) => value,
      now: () => Date.parse("2026-08-23T06:30:00.000Z"),
      leaseTimeoutMs: 60_000,
      recover: vi.fn(async (_registration, _disposition, recoveredTask) => recoveredTask),
      terminalize,
    });

    expect(terminalize).toHaveBeenCalledWith(
      current,
      expect.anything(),
      { code, message },
      disposition,
    );
  });

  currentPolicySnapshot.each([
    "adopt_prebootstrap",
    "adopt_running",
    "replay_terminal",
    "replay_terminal_dead",
  ] as const)("delegates a refreshed %s runner instead of applying a stale reap decision", async (
    verifiedDisposition,
  ) => {
    const hydrated = registrationForDisposition(verifiedDisposition);
    const recover = vi.fn(async (_registration, _disposition, recoveredTask: Task) => recoveredTask);
    const terminalize = vi.fn(async () => {});

    await reapAndResumeRunner({
      registration: hydrated,
      disposition: "reap_dead",
      task: task(),
      hydrate: async () => hydrated,
      now: () => Date.parse("2026-08-23T06:30:00.000Z"),
      leaseTimeoutMs: 60_000,
      recover,
      terminalize,
    });

    expect(recover).toHaveBeenCalledWith(hydrated, verifiedDisposition, expect.anything());
    expect(terminalize).not.toHaveBeenCalled();
  });

  currentPolicySnapshot("returns without destructive recovery when the refreshed registration is closed", async () => {
    const closed = registration({ lifecycleState: "closed", pidAlive: false });
    const recover = vi.fn(async (_registration, _disposition, recoveredTask: Task) => recoveredTask);
    const terminalize = vi.fn(async () => {});

    await expect(reapAndResumeRunner({
      registration: closed,
      disposition: "reap_dead",
      task: task(),
      hydrate: async () => closed,
      now: () => Date.parse("2026-08-23T06:30:00.000Z"),
      leaseTimeoutMs: 60_000,
      recover,
      terminalize,
    })).resolves.toBeUndefined();

    expect(recover).not.toHaveBeenCalled();
    expect(terminalize).not.toHaveBeenCalled();
  });

  it.skip("불변식 16: refreshed non-recoverable dispositions use an explicit decision table", async () => {
    const moduleExports = await import("../../src/runner/runner_recovery_disposition.js");
    const explicitTables = Object.values(moduleExports).filter((value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
      const keys = Object.keys(value);
      return keys.length === ALL_DISPOSITIONS.length
        && ALL_DISPOSITIONS.every((disposition) => disposition in value);
    });

    // Current code expresses the decision in scattered branches, so this is
    // zero until redesign 2-3 introduces the exhaustive policy record.
    expect(explicitTables).toHaveLength(1);
  });
});

describe("recoverRunnerByDisposition", () => {
  currentPolicySnapshot.each(["adopt_prebootstrap", "adopt_running"] as const)(
    "routes %s to live adoption",
    async (disposition) => {
      const recoveredTask = task();
      const recoverAdopt = vi.fn(async () => recoveredTask);
      const input = recoveryByDispositionInput(disposition, { recoverAdopt });

      await expect(recoverRunnerByDisposition(input)).resolves.toBe(recoveredTask);
      expect(recoverAdopt).toHaveBeenCalledWith(input.registration, input.task, disposition);
      expect(input.recoverOffline).not.toHaveBeenCalled();
    },
  );

  it("stops a live terminal process before offline replay", async () => {
    const order: string[] = [];
    const input = recoveryByDispositionInput("replay_terminal", {
      registration: registration({ pidAlive: true, lifecycleState: "completed" }),
      terminate: vi.fn(async () => { order.push("terminate"); }),
      recoverOffline: vi.fn(async (_registration, recoveredTask, prepare) => {
        order.push("prepare");
        const prepared = await prepare(_registration);
        expect(prepared.pidAlive).toBe(false);
        order.push("replay");
        return { task: recoveredTask, replayed: true };
      }),
    });

    await recoverRunnerByDisposition(input);

    expect(order).toEqual(["prepare", "terminate", "replay"]);
    expect(input.retireTerminal).not.toHaveBeenCalled();
  });

  it("keeps a dead terminal registration when replay did not run", async () => {
    const input = recoveryByDispositionInput("replay_terminal_dead", {
      recoverOffline: vi.fn(async (_registration, recoveredTask) => ({
        task: recoveredTask,
        replayed: false,
      })),
    });

    await recoverRunnerByDisposition(input);

    expect(input.retireTerminal).not.toHaveBeenCalled();
    expect(input.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ disposition: "replay_terminal_dead" }),
      "terminal runner replay was skipped; registration kept for a later scan",
    );
  });

  it("retires a dead terminal registration only after successful replay", async () => {
    const input = recoveryByDispositionInput("replay_terminal_dead");

    await recoverRunnerByDisposition(input);

    expect(input.retireTerminal).toHaveBeenCalledWith(input.registration);
    expect(input.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ disposition: "replay_terminal_dead" }),
      "terminal runner with no live process replayed offline and retired",
    );
  });
});

function failureTrackingSubject(overrides: { handle?: ReturnType<typeof vi.fn> } = {}) {
  const handle = overrides.handle ?? vi.fn(async () => {});
  const clearFailure = vi.fn();
  const recordFailure = vi.fn();
  const clearBackoff = vi.fn();
  const observeConflict = vi.fn();
  const recoveryLogger = {
    clear: clearFailure,
    failure: recordFailure,
  } as unknown as RunnerRecoveryLogger;
  const ownershipBackoff = {
    clear: clearBackoff,
    observeConflict,
  } as unknown as ExecutionOwnershipBackoff;
  const input = {
    registration: registration(),
    disposition: "adopt_running" as RunnerRecoveryDisposition,
    task: task(),
    handle,
    recoveryLogger,
    ownershipBackoff,
  };
  return {
    input,
    handle,
    clearFailure,
    recordFailure,
    clearBackoff,
    observeConflict,
  };
}

function recoveryByDispositionInput(
  disposition: "adopt_prebootstrap" | "adopt_running" | "replay_terminal" | "replay_terminal_dead",
  overrides: Record<string, unknown> = {},
) {
  return {
    registration: registration({
      pidAlive: disposition === "replay_terminal",
      lifecycleState: disposition.startsWith("replay") ? "completed" : "running",
    }),
    disposition,
    task: task(),
    recoverAdopt: vi.fn(async (_registration: RunnerRegistration, recoveredTask: Task) => recoveredTask),
    recoverOffline: vi.fn(async (
      _registration: RunnerRegistration,
      recoveredTask: Task,
      prepare: (registration: RunnerRegistration) => Promise<RunnerRegistration>,
    ) => {
      await prepare(_registration);
      return { task: recoveredTask, replayed: true };
    }),
    terminate: vi.fn(async () => {}),
    retireTerminal: vi.fn(async () => {}),
    logger: { info: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
}

function registrationForDisposition(disposition: "adopt_prebootstrap" | "adopt_running" | "replay_terminal" | "replay_terminal_dead") {
  if (disposition === "adopt_prebootstrap") {
    return registration({ lifecycleState: null, pidAlive: true });
  }
  if (disposition === "adopt_running") {
    return registration({ lifecycleState: "running", pidAlive: true });
  }
  return registration({
    lifecycleState: "completed",
    pidAlive: disposition === "replay_terminal",
  });
}

function registration(options: {
  sessionId?: string;
  pidAlive?: boolean;
  lifecycleState?: "running" | "completed" | "failed" | "reaped" | "closed" | null;
  progressedAt?: string;
} = {}): RunnerRegistration {
  const sessionId = options.sessionId ?? "session-a";
  const lifecycleState = options.lifecycleState === undefined ? "running" : options.lifecycleState;
  return {
    config: {
      sessionId,
      codeSha: "sha-a",
      claudeRuntimeTurnTimeoutMs: 60_000,
      agent: { id: "agent-a", name: "Agent A" },
      paths: { sessionDirectory: `/runner/${sessionId}` },
    } as RunnerRegistration["config"],
    pid: 4123,
    pidAlive: options.pidAlive ?? true,
    registeredAtMs: Date.parse("2026-08-23T06:29:30.000Z"),
    bootstrap: null,
    lifecycle: lifecycleState === null ? null : {
      session_id: sessionId,
      runner_pid: 4123,
      execution_command_id: "execute-a",
      execution_state: lifecycleState,
      progress_seq: 1,
      progress_at: options.progressedAt ?? "2026-08-23T06:29:50.000Z",
      liveness_at: options.progressedAt ?? "2026-08-23T06:29:50.000Z",
      in_flight_tools: [],
      terminal_error: lifecycleState === "reaped"
        ? { code: "terminal", message: "terminal failure" }
        : null,
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
    createdAt: new Date("2026-08-23T06:00:00.000Z"),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
  };
}
