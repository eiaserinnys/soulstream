import { describe, expect, it, vi } from "vitest";

import {
  terminateExactRunner,
  type RunnerProcessTerminationDependencies,
} from "../../src/runner/runner_process_termination.js";

const expectedRunner = {
  pid: 6_301,
  startIdentity: "linux-proc-123",
};

describe("terminateExactRunner", () => {
  it("accepts exit when the process vanishes during start identity inspection", async () => {
    const isPidAlive = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const inspectProcess = vi.fn(async () => ({
      alive: true,
      startIdentity: null,
    }));
    const signalPid = vi.fn();

    await expect(terminateExactRunner(expectedRunner, dependencies({
      inspectProcess,
      isPidAlive,
      signalPid,
    }))).resolves.toBeUndefined();

    expect(inspectProcess).toHaveBeenCalledOnce();
    expect(isPidAlive).toHaveBeenCalledTimes(2);
    expect(signalPid).not.toHaveBeenCalled();
  });

  it("fails closed when a still-live process has no start identity", async () => {
    const isPidAlive = vi.fn(() => true);
    const signalPid = vi.fn();

    await expect(terminateExactRunner(expectedRunner, dependencies({
      inspectProcess: async () => ({ alive: true, startIdentity: null }),
      isPidAlive,
      signalPid,
    }))).rejects.toMatchObject({
      code: "runner_registration_identity_proof_failed",
    });

    expect(isPidAlive).toHaveBeenCalledTimes(2);
    expect(signalPid).not.toHaveBeenCalled();
  });
});

function dependencies(
  overrides: Partial<RunnerProcessTerminationDependencies>,
): RunnerProcessTerminationDependencies {
  return {
    inspectProcess: async () => ({ alive: false, startIdentity: null }),
    isPidAlive: () => false,
    signalPid: vi.fn(),
    now: () => 0,
    delay: async () => {},
    ...overrides,
  };
}
