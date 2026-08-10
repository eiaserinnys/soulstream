import { describe, expect, it, vi } from "vitest";

import {
  composeRunnerProcessRuntime,
  composeRunnerReconciliationReporter,
  startRunnerRecoveryCoordinator,
} from "../../src/runtime/runner_process_composition.js";

describe("runner process composition feature gate", () => {
  it("does not construct or validate runner process dependencies while disabled", () => {
    expect(composeRunnerProcessRuntime(false, {} as never)).toBeUndefined();
  });

  it("does not require runner state configuration without a process factory", async () => {
    await expect(startRunnerRecoveryCoordinator({
      env: {} as never,
      runnerProcessFactory: undefined,
      taskManager: {} as never,
      taskExecutor: {} as never,
      logger: {} as never,
    })).resolves.toBeUndefined();
  });

  it("does not expose runner reconciliation dependencies while disabled", () => {
    expect(composeRunnerReconciliationReporter(
      {} as never,
      undefined,
      undefined,
    )).toEqual({});
  });

  it("waits for recovery before reading the enabled runner inventory", async () => {
    const waitForSettled = vi.fn(async () => {});
    const reporter = composeRunnerReconciliationReporter(
      {
        SOUL_RUNNER_STATE_DIR: "/runner-directory-that-does-not-exist",
        SOUL_RUNNER_LEASE_TIMEOUT_MS: 120_000,
      } as never,
      {} as never,
      { waitForSettled } as never,
    );

    await reporter.waitForRunnerReconciliation!();
    await expect(reporter.listLiveRunnerSessionIds!()).resolves.toEqual([]);
    expect(waitForSettled).toHaveBeenCalledOnce();
  });
});
