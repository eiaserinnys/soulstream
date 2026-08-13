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
import { listLiveRunnerSessionIds } from "../runner/runner_process_registry.js";
import { RunnerReleaseGarbageCollector } from "../runner/runner_release_gc.js";
import { BuildArtifactReleaseMaterializer } from "../runner/runner_release_materializer.js";
import { RunnerReleasePool } from "../runner/runner_release_pool.js";
import { RunnerStateHostLock } from "../runner/runner_state_host_lock.js";
import { RunnerSessionGarbageCollector } from "../runner/runner_session_gc.js";
import { ClosedRunnerTailDrainer } from "../runner/closed_runner_tail_drainer.js";
import type { EventOutboxPumpMux } from "../upstream/event_outbox_pump_mux.js";

export interface RunnerProcessComposition {
  runtimeFactory: RunnerProcessRuntimeFactory;
  releaseGarbageCollector: RunnerReleaseGarbageCollector;
  hostOwnership: RunnerStateHostLock;
  sessionGarbageCollector: RunnerSessionGarbageCollector;
  closedTailDrainer: ClosedRunnerTailDrainer;
}

export type RunnerReconciliationReporter = {
  listLiveRunnerSessionIds(): Promise<string[]>;
  waitForRunnerReconciliation(): Promise<void>;
};

export async function composeRunnerProcessRuntime(
  enabled: boolean,
  options: Omit<RunnerProcessRuntimeFactoryOptions, "releasePool">,
): Promise<RunnerProcessComposition | undefined> {
  if (!enabled) return undefined;
  const artifactDirectory = required(
    options.env.SOUL_RUNNER_ARTIFACT_DIR,
    "SOUL_RUNNER_ARTIFACT_DIR",
  );
  const releasesDirectory = required(
    options.env.SOUL_RUNNER_RELEASES_DIR,
    "SOUL_RUNNER_RELEASES_DIR",
  );
  const stateDirectory = required(options.env.SOUL_RUNNER_STATE_DIR, "SOUL_RUNNER_STATE_DIR");
  const hostOwnership = await RunnerStateHostLock.acquire(stateDirectory);
  try {
    const materializer = new BuildArtifactReleaseMaterializer(artifactDirectory);
    const releasePool = new RunnerReleasePool(releasesDirectory, materializer);
    const release = await releasePool.resolveCurrentRelease();
    await releasePool.ensureRelease(release);
    return {
      runtimeFactory: createRunnerProcessRuntimeFactory({ ...options, releasePool }),
      releaseGarbageCollector: new RunnerReleaseGarbageCollector(
        releasePool,
        stateDirectory,
        options.logger,
      ),
      hostOwnership,
      sessionGarbageCollector: new RunnerSessionGarbageCollector(
        stateDirectory,
        options.env.SOUL_RUNNER_TERMINAL_RETENTION_MS,
        options.logger,
      ),
      closedTailDrainer: new ClosedRunnerTailDrainer({
        pumpMux: options.pumpMux,
        logger: options.logger,
      }),
    };
  } catch (error) {
    await hostOwnership.release();
    throw error;
  }
}

export async function startRunnerRecoveryCoordinator(options: {
  env: Env;
  runnerProcessFactory?: RunnerProcessRuntimeFactory;
  releaseGarbageCollector?: Pick<RunnerReleaseGarbageCollector, "collect">;
  sessionGarbageCollector?: Pick<RunnerSessionGarbageCollector, "collect">;
  closedTailDrainer?: Pick<ClosedRunnerTailDrainer, "drain">;
  taskManager: Pick<TaskManager, "hydrateRunnerRecoveryTask" | "markRunnerFailureAndResume">;
  taskExecutor: Pick<TaskExecutor, "recoverRegisteredRunner" | "restartRegisteredRunner">;
  logger: Logger;
}): Promise<RunnerRecoveryCoordinator | undefined> {
  if (!options.runnerProcessFactory) return undefined;
  if (!options.closedTailDrainer) {
    throw new Error("closed runner tail drainer required for runner recovery");
  }
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
    closedTailDrainer: options.closedTailDrainer,
    logger: options.logger,
    ...(options.releaseGarbageCollector
      ? { releaseGarbageCollector: options.releaseGarbageCollector }
      : {}),
    ...(options.sessionGarbageCollector
      ? { sessionGarbageCollector: options.sessionGarbageCollector }
      : {}),
  });
  await coordinator.start();
  return coordinator;
}

export function composeRunnerReconciliationReporter(
  env: Env,
  runnerProcessFactory: RunnerProcessRuntimeFactory | undefined,
  coordinator: RunnerRecoveryCoordinator | undefined,
  logger: Pick<Logger, "debug">,
): Partial<RunnerReconciliationReporter> {
  if (!runnerProcessFactory) return {};
  const stateDirectory = env.SOUL_RUNNER_STATE_DIR;
  if (!stateDirectory || !coordinator) {
    throw new Error("runner inventory requires state directory and recovery coordinator");
  }
  return {
    listLiveRunnerSessionIds: async () => await listLiveRunnerSessionIds({
      stateDirectory,
      leaseTimeoutMs: env.SOUL_RUNNER_LEASE_TIMEOUT_MS,
      logger,
    }),
    waitForRunnerReconciliation: async () => await coordinator.waitForSettled(),
  };
}

function required(value: string | undefined, key: string): string {
  if (!value) throw new Error(`${key} required for runner process mode`);
  return value;
}
