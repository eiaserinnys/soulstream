import { describe, expect, it } from "vitest";

import {
  composeRunnerProcessRuntime,
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
});
