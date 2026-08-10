import type { Logger } from "pino";

import type { Env } from "../config.js";
import type { TaskExecutor } from "../task/task_executor.js";
import type { TaskManager } from "../task/task_manager.js";
import type { RunnerProcessRuntimeFactory } from "../task/task_executor.js";
import {
  createRunnerProcessRuntimeFactory,
  type RunnerProcessRuntimeFactoryOptions,
} from "../runner/runner_process_runtime_factory.js";
import { RunnerRecoveryCoordinator } from "../runner/runner_recovery_coordinator.js";

export function composeRunnerProcessRuntime(
  enabled: boolean,
  options: RunnerProcessRuntimeFactoryOptions,
): RunnerProcessRuntimeFactory | undefined {
  return enabled ? createRunnerProcessRuntimeFactory(options) : undefined;
}

export async function startRunnerRecoveryCoordinator(options: {
  env: Env;
  runnerProcessFactory?: RunnerProcessRuntimeFactory;
  taskManager: Pick<TaskManager, "hydrateRunnerRecoveryTask" | "markRunnerFailureAndResume">;
  taskExecutor: Pick<TaskExecutor, "recoverRegisteredRunner" | "restartRegisteredRunner">;
  logger: Logger;
}): Promise<RunnerRecoveryCoordinator | undefined> {
  if (!options.runnerProcessFactory) return undefined;
  const stateDirectory = options.env.SOUL_RUNNER_STATE_DIR;
  if (!stateDirectory) {
    throw new Error("SOUL_RUNNER_STATE_DIR required for runner recovery");
  }
  const coordinator = new RunnerRecoveryCoordinator({
    stateDirectory,
    leaseTimeoutMs: options.env.SOUL_RUNNER_LEASE_TIMEOUT_MS,
    scanIntervalMs: options.env.SOUL_RUNNER_REAPER_INTERVAL_MS,
    taskManager: options.taskManager,
    taskExecutor: options.taskExecutor,
    logger: options.logger,
  });
  await coordinator.start();
  return coordinator;
}
