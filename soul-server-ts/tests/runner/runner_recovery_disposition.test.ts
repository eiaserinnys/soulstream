import { describe, expect, it, vi } from "vitest";

import type { Task } from "../../src/task/task_models.js";
import type {
  RunnerRegistration,
  RunnerRecoveryDisposition,
} from "../../src/runner/runner_process_registry.js";
import {
  dispositionRequiresTask,
  handleRecoveryWithFailureTracking,
  recoverRunnerByDisposition,
  terminalizeFailedRunner,
  terminalizeReapedRunner,
} from "../../src/runner/runner_recovery_disposition.js";
import type { RunnerRecoveryLogger } from "../../src/runner/runner_recovery_logging.js";

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
  it.each(ALL_DISPOSITIONS)("declares whether %s requires a hydrated task", (disposition) => {
    expect(dispositionRequiresTask(disposition)).toBe(
      disposition !== "wait_for_bootstrap" && disposition !== "retired_terminal",
    );
  });
});

describe("handleRecoveryWithFailureTracking", () => {
  it("clears failure state after recovery succeeds", async () => {
    const clear = vi.fn();
    const handle = vi.fn(async () => {});
    await handleRecoveryWithFailureTracking({
      registration: registration(),
      disposition: "adopt_running",
      task: task(),
      handle,
      recoveryLogger: { clear, failure: vi.fn() } as unknown as RunnerRecoveryLogger,
    });
    expect(handle).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledWith("session-a");
  });

  it("records failure against the exact disposition", async () => {
    const error = new Error("recovery failed");
    const failure = vi.fn();
    await handleRecoveryWithFailureTracking({
      registration: registration(),
      disposition: "replay_terminal_dead",
      task: task(),
      handle: vi.fn(async () => { throw error; }),
      recoveryLogger: { clear: vi.fn(), failure } as unknown as RunnerRecoveryLogger,
    });
    expect(failure).toHaveBeenCalledWith(
      expect.objectContaining({ registrationId: "registration-a" }),
      "replay_terminal_dead",
      error,
    );
  });
});

describe("terminal-only failure recovery", () => {
  it("replays a reaped terminal fact without creating a replacement", async () => {
    const order: string[] = [];
    const inputTask = task();
    const current = registration({ pidAlive: true, lifecycleState: "reaped" });
    await terminalizeReapedRunner({
      registration: current,
      task: inputTask,
      hydrate: async (value) => value,
      terminate: async () => { order.push("terminate"); },
      invalidate: async () => { order.push("invalidate"); },
      recoverOffline: async (owned, recoveredTask) => {
        order.push("recover");
        expect(owned.pidAlive).toBe(false);
        expect(recoveredTask.runnerTerminalFact).toBe("reaped");
        return recoveredTask;
      },
      logger: { info: vi.fn() },
    });
    expect(order).toEqual(["terminate", "invalidate", "recover"]);
  });

  it("terminalizes a still-verified dead runner", async () => {
    const terminalize = vi.fn(async () => {});
    const current = registration({
      pidAlive: false,
      lifecycleState: "running",
      progressedAt: "2026-08-23T06:29:50.000Z",
    });
    await terminalizeFailedRunner({
      registration: current,
      disposition: "reap_dead",
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
      { code: "runner_exited", message: "runner process exited before execution completed" },
      "reap_dead",
    );
  });

  it.each([
    "adopt_prebootstrap",
    "adopt_running",
    "replay_terminal",
    "replay_terminal_dead",
  ] as const)("delegates refreshed %s evidence instead of applying a stale reap", async (
    verifiedDisposition,
  ) => {
    const hydrated = registrationForDisposition(verifiedDisposition);
    const recover = vi.fn(async (_registration, _disposition, recoveredTask: Task) => recoveredTask);
    const terminalize = vi.fn(async () => {});
    await terminalizeFailedRunner({
      registration: registration({ pidAlive: false }),
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
});

describe("recoverRunnerByDisposition", () => {
  it.each(["adopt_prebootstrap", "adopt_running"] as const)(
    "routes %s to same-runner live adoption",
    async (disposition) => {
      const recoveredTask = task();
      const recoverAdopt = vi.fn(async () => recoveredTask);
      const input = recoveryInput(disposition, { recoverAdopt });
      await expect(recoverRunnerByDisposition(input)).resolves.toBe(recoveredTask);
      expect(recoverAdopt).toHaveBeenCalledWith(input.registration, input.task, disposition);
    },
  );

  it("retires a dead terminal registration only after successful replay", async () => {
    const input = recoveryInput("replay_terminal_dead");
    await recoverRunnerByDisposition(input);
    expect(input.retireTerminal).toHaveBeenCalledWith(input.registration);
  });

  it("keeps terminal evidence when replay did not run", async () => {
    const input = recoveryInput("replay_terminal_dead", {
      recoverOffline: vi.fn(async (_registration: RunnerRegistration, recoveredTask: Task) => ({
        task: recoveredTask,
        replayed: false,
      })),
    });
    await recoverRunnerByDisposition(input);
    expect(input.retireTerminal).not.toHaveBeenCalled();
  });
});

function recoveryInput(
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
      owned: RunnerRegistration,
      recoveredTask: Task,
      prepare: (registration: RunnerRegistration) => Promise<RunnerRegistration>,
    ) => {
      await prepare(owned);
      return { task: recoveredTask, replayed: true };
    }),
    terminate: vi.fn(async () => {}),
    retireTerminal: vi.fn(async () => {}),
    logger: { info: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
}

function registrationForDisposition(
  disposition: "adopt_prebootstrap" | "adopt_running" | "replay_terminal" | "replay_terminal_dead",
): RunnerRegistration {
  if (disposition === "adopt_prebootstrap") return registration({ lifecycleState: null });
  if (disposition === "adopt_running") return registration({ lifecycleState: "running" });
  return registration({
    lifecycleState: "completed",
    pidAlive: disposition === "replay_terminal",
  });
}

function registration(options: {
  pidAlive?: boolean;
  lifecycleState?: "running" | "completed" | "failed" | "reaped" | "closed" | null;
  progressedAt?: string;
} = {}): RunnerRegistration {
  const lifecycleState = options.lifecycleState === undefined ? "running" : options.lifecycleState;
  return {
    config: {
      sessionId: "session-a",
      codeSha: "sha-a",
      claudeRuntimeTurnTimeoutMs: 60_000,
      agent: { id: "agent-a", name: "Agent A" },
      paths: { sessionDirectory: "/runner/session-a" },
    } as RunnerRegistration["config"],
    pid: 4123,
    pidAlive: options.pidAlive ?? true,
    registeredAtMs: Date.parse("2026-08-23T06:29:30.000Z"),
    bootstrap: null,
    lifecycle: lifecycleState === null ? null : {
      session_id: "session-a",
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

function task(): Task {
  return {
    agentSessionId: "session-a",
    prompt: "continue",
    status: "running",
    createdAt: new Date("2026-08-23T06:00:00.000Z"),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
  };
}
