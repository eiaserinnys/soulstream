import { describe, expect, it, vi } from "vitest";

import {
  exactRunnerStartIdentitiesMatch,
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
  it("matches the runner self timestamp to an equivalent Windows process identity", () => {
    const unixStartMs = 1_700_000_000_123;
    const windowsTicks = 621_355_968_000_000_000n + BigInt(unixStartMs) * 10_000n;

    expect(exactRunnerStartIdentitiesMatch(
      `node-start-${unixStartMs}`,
      `windows-process-${windowsTicks}`,
    )).toBe(true);
  });

  it("waits for shutdown grace before terminating the exact Windows process tree", async () => {
    let now = 0;
    let treeTerminated = false;
    const events: string[] = [];
    const delay = vi.fn(async (ms: number) => {
      now += ms;
    });
    const terminateProcessTree = vi.fn(async () => {
      expect(now).toBeGreaterThanOrEqual(2_000);
      events.push("taskkill");
      treeTerminated = true;
    });
    const requestShutdown = vi.fn(async () => {
      events.push("ipc");
    });
    const signalPid = vi.fn();

    await expect(terminateExactRunner(expectedRunner, dependencies({
      platform: "win32",
      inspectWriterLock: vi.fn(async () => treeTerminated
        ? { kind: "free" }
        : { kind: "held", owner: expectedRunner }),
      requestShutdown,
      terminateProcessTree,
      signalPid,
      now: () => now,
      delay,
    }), lockPath, undefined, "/runner/session-a/runner.sock")).resolves.toBeUndefined();

    expect(requestShutdown).toHaveBeenCalledWith("/runner/session-a/runner.sock");
    expect(terminateProcessTree).toHaveBeenCalledWith(expectedRunner.pid);
    expect(delay).toHaveBeenCalled();
    expect(events).toEqual(["ipc", "taskkill"]);
    expect(signalPid).not.toHaveBeenCalled();
  });

  it("does not send Windows shutdown or taskkill when the lock is free", async () => {
    const requestShutdown = vi.fn(async () => undefined);
    const terminateProcessTree = vi.fn(async () => undefined);

    await expect(terminateExactRunner(expectedRunner, dependencies({
      platform: "win32",
      inspectWriterLock: sequence({ kind: "free" }),
      requestShutdown,
      terminateProcessTree,
    }), lockPath, undefined, "/runner/session-a/runner.sock")).resolves.toBeUndefined();

    expect(requestShutdown).not.toHaveBeenCalled();
    expect(terminateProcessTree).not.toHaveBeenCalled();
  });

  it("does not taskkill when the Windows process exits during the IPC grace", async () => {
    const requestShutdown = vi.fn(async () => undefined);
    const terminateProcessTree = vi.fn(async () => undefined);

    await expect(terminateExactRunner(expectedRunner, dependencies({
      platform: "win32",
      inspectWriterLock: sequence(
        { kind: "held", owner: expectedRunner },
        { kind: "free" },
      ),
      requestShutdown,
      terminateProcessTree,
    }), lockPath, undefined, "/runner/session-a/runner.sock")).resolves.toBeUndefined();

    expect(requestShutdown).toHaveBeenCalledOnce();
    expect(terminateProcessTree).not.toHaveBeenCalled();
  });

  it("does not taskkill a Windows pid when its held-lock identity differs", async () => {
    const requestShutdown = vi.fn(async () => undefined);
    const terminateProcessTree = vi.fn(async () => undefined);

    await expect(terminateExactRunner(expectedRunner, dependencies({
      platform: "win32",
      inspectWriterLock: sequence({
        kind: "held",
        owner: { pid: expectedRunner.pid, startIdentity: "replacement-process" },
      }),
      requestShutdown,
      terminateProcessTree,
    }), lockPath, undefined, "/runner/session-a/runner.sock")).rejects.toMatchObject({
      code: "runner_registration_identity_proof_failed",
    });

    expect(requestShutdown).not.toHaveBeenCalled();
    expect(terminateProcessTree).not.toHaveBeenCalled();
  });

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
