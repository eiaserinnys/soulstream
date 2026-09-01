import { describe, expect, it, vi } from "vitest";

import {
  terminateExactRunner,
  type RunnerProcessTerminationDependencies,
} from "../../src/runner/runner_process_termination.js";
import type { RunnerWriterLockState } from "../../src/runner/runner_writer_lock.js";

const expectedRunner = {
  pid: 6_301,
  startIdentity: "runner-lock-owner-123",
};
const lockPath = "/runner/session-a/runner.lock";

describe("terminateExactRunner", () => {
  it("treats a free lock as death even when an unrelated process occupies the stale pid", async () => {
    const signalPid = vi.fn();
    const inspectProcess = vi.fn(async () => {
      throw new Error("pid identity must not be consulted");
    });

    await expect(terminateExactRunner(expectedRunner, dependencies({
      inspectWriterLock: sequence({ kind: "free" }),
      inspectProcess,
      signalPid,
    }), lockPath)).resolves.toBeUndefined();

    expect(inspectProcess).not.toHaveBeenCalled();
    expect(signalPid).not.toHaveBeenCalled();
  });

  it("signals only the exact owner and observes death from the lock transition", async () => {
    const signalPid = vi.fn();

    await expect(terminateExactRunner(expectedRunner, dependencies({
      inspectWriterLock: sequence(
        { kind: "held", owner: expectedRunner },
        { kind: "free" },
      ),
      signalPid,
    }), lockPath)).resolves.toBeUndefined();

    expect(signalPid).toHaveBeenCalledOnce();
    expect(signalPid).toHaveBeenCalledWith(expectedRunner.pid, "SIGTERM");
  });

  it("retries the held-without-record release transition after signaling", async () => {
    const signalPid = vi.fn();
    const delay = vi.fn(async () => undefined);

    await expect(terminateExactRunner(expectedRunner, dependencies({
      inspectWriterLock: sequence(
        { kind: "held", owner: expectedRunner },
        { kind: "unavailable" },
        { kind: "free" },
      ),
      signalPid,
      delay,
    }), lockPath)).resolves.toBeUndefined();

    expect(signalPid).toHaveBeenCalledWith(expectedRunner.pid, "SIGTERM");
    expect(delay).toHaveBeenCalledOnce();
  });

  it("does not touch a different live lock owner", async () => {
    const signalPid = vi.fn();

    await expect(terminateExactRunner(expectedRunner, dependencies({
      inspectWriterLock: sequence({
        kind: "held",
        owner: { pid: 6_302, startIdentity: "replacement-owner" },
      }),
      signalPid,
    }), lockPath)).rejects.toMatchObject({
      code: "runner_registration_identity_proof_failed",
    });

    expect(signalPid).not.toHaveBeenCalled();
  });

  it("fails closed when the kernel lock owner record is unavailable", async () => {
    const signalPid = vi.fn();

    await expect(terminateExactRunner(expectedRunner, dependencies({
      inspectWriterLock: sequence({ kind: "unavailable" }),
      signalPid,
    }), lockPath)).rejects.toMatchObject({
      code: "runner_registration_identity_proof_failed",
    });

    expect(signalPid).not.toHaveBeenCalled();
  });
});

function dependencies(
  overrides: Partial<RunnerProcessTerminationDependencies>,
): RunnerProcessTerminationDependencies {
  return {
    inspectWriterLock: sequence({ kind: "free" }),
    inspectProcess: async () => ({ alive: false, startIdentity: null }),
    signalPid: vi.fn(),
    now: () => 0,
    delay: async () => {},
    ...overrides,
  };
}

function sequence(...states: RunnerWriterLockState[]) {
  let index = 0;
  return vi.fn(async () => states[Math.min(index++, states.length - 1)]!);
}
