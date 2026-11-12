import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, onTestFinished, vi } from "vitest";

import {
  exactRunnerStartIdentitiesMatch,
  stopExistingRunnerLocked,
  terminateExactRunner,
  type RunnerProcessTerminationDependencies,
} from "../../src/runner/runner_process_termination.js";
import type { RunnerProcessPaths } from "../../src/runner/runner_process_paths.js";
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

describe("stopExistingRunnerLocked against this host process", () => {
  it("refuses to signal the lock owner when it is the host process itself", async () => {
    const paths = await sessionPaths();
    let now = 0;
    const signalPid = vi.fn();
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    onTestFinished(() => emitWarning.mockRestore());

    await expect(stopExistingRunnerLocked(paths, dependencies({
      signalPid,
      inspectWriterLock: sequence({
        kind: "held",
        owner: { pid: process.pid, startIdentity: "host-process-lock-owner" },
      }),
      now: () => now,
      delay: async (ms: number) => {
        now += ms;
      },
    }), undefined, "replacement")).rejects.toMatchObject({
      code: "runner_termination_self_signal_refused",
    });

    expect(signalPid).not.toHaveBeenCalled();
    expect(emitWarning).toHaveBeenCalledOnce();
    expect(String(emitWarning.mock.calls[0]?.[0])).toContain("host process itself");
  });

  it("refuses Windows process-tree termination of the host process itself", async () => {
    const paths = await sessionPaths();
    let now = 0;
    const terminateProcessTree = vi.fn(async () => undefined);
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    onTestFinished(() => emitWarning.mockRestore());

    await expect(stopExistingRunnerLocked(paths, dependencies({
      platform: "win32",
      requestShutdown: vi.fn(async () => undefined),
      terminateProcessTree,
      inspectWriterLock: sequence({
        kind: "held",
        owner: { pid: process.pid, startIdentity: "host-process-lock-owner" },
      }),
      now: () => now,
      delay: async (ms: number) => {
        now += ms;
      },
    }), undefined, "replacement")).rejects.toMatchObject({
      code: "runner_termination_self_signal_refused",
    });

    expect(terminateProcessTree).not.toHaveBeenCalled();
  });
});

async function sessionPaths(): Promise<RunnerProcessPaths> {
  const sessionDirectory = await mkdtemp(join(tmpdir(), "card1265-runner-"));
  return {
    sessionDirectory,
    databasePath: join(sessionDirectory, "runner.sqlite"),
    socketPath: join(sessionDirectory, "runner.sock"),
    socketKind: "unix_socket",
    pidPath: join(sessionDirectory, "runner.pid"),
    lockPath: join(sessionDirectory, "runner.lock"),
    configPath: join(sessionDirectory, "runner-config.json"),
    logPath: join(sessionDirectory, "runner.log"),
  };
}

function dependencies(
  overrides: Partial<RunnerProcessTerminationDependencies>,
): RunnerProcessTerminationDependencies {
  return {
    platform: "linux",
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
