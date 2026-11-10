import type { Logger } from "pino";

import type { Env } from "../config.js";
import type { TaskExecutor } from "../task/task_executor.js";
import type { TaskManager } from "../task/task_manager.js";
import type { ExecutionRegistration } from "../task/execution_registration.js";
import type { ClaudeBackgroundTaskLifecycle } from "../task/claude_background_task_lifecycle.js";
import type { RunnerProcessRuntimeFactory } from "../task/task_executor.js";
import {
  createRunnerProcessRuntimeFactory,
  type RunnerProcessRuntimeFactoryOptions,
} from "../runner/runner_process_runtime_factory.js";
import { RunnerRecoveryCoordinator } from "../runner/runner_recovery_coordinator.js";
import { RunnerOrphanReaper } from "../runner/runner_orphan_reaper.js";
import { listLiveRunnerSessionIds } from "../runner/runner_process_registry.js";
import { RunnerRegistrationScanCache } from "../runner/runner_registration_scan_cache.js";
import { RunnerReleaseGarbageCollector } from "../runner/runner_release_gc.js";
import { BuildArtifactReleaseMaterializer } from "../runner/runner_release_materializer.js";
import { RunnerReleasePool } from "../runner/runner_release_pool.js";
import { RunnerStateHostLock } from "../runner/runner_state_host_lock.js";
import { RunnerSessionGarbageCollector } from "../runner/runner_session_gc.js";
import { RunnerRecoveryStorage } from "../runner/runner_recovery_storage.js";
import { ClosedRunnerTailDrainer } from "../runner/closed_runner_tail_drainer.js";
import type { EventOutboxPumpMux } from "../upstream/event_outbox_pump_mux.js";
import type { NodeStallMonitor } from "./node_stall_monitor.js";
import { createRunnerPhaseObservation } from "../runner/runner_phase_observation.js";

export interface RunnerProcessComposition {
  runtimeFactory: RunnerProcessRuntimeFactory;
  releaseGarbageCollector: RunnerReleaseGarbageCollector;
  hostOwnership: RunnerStateHostLock;
  sessionGarbageCollector: RunnerSessionGarbageCollector;
  closedTailDrainer: ClosedRunnerTailDrainer;
  recoveryStorage: RunnerRecoveryStorage;
}

export function composeRunnerOrphanReaper(options: {
  runnerProcess: RunnerProcessComposition | undefined;
  logger: Logger;
  intervalMs: number;
}): { runnerOrphanReaper?: RunnerOrphanReaper } {
  if (!options.runnerProcess || process.platform !== "linux") return {};
  return { runnerOrphanReaper: new RunnerOrphanReaper({ logger: options.logger, intervalMs: options.intervalMs }) };
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
  const recoveryStorage = new RunnerRecoveryStorage();
  try {
    const materializer = new BuildArtifactReleaseMaterializer(artifactDirectory);
    const releasePool = new RunnerReleasePool(releasesDirectory, materializer);
    const release = options.releaseManifest
      ? releasePool.describe(options.releaseManifest.runner_release_id)
      : await releasePool.resolveCurrentRelease();
    await releasePool.ensureRelease(release);
    return {
      runtimeFactory: createRunnerProcessRuntimeFactory({
        ...options,
        releasePool,
        recoveryStorage,
      }),
      releaseGarbageCollector: new RunnerReleaseGarbageCollector(
        releasePool,
        stateDirectory,
        options.logger,
        undefined,
        recoveryStorage,
      ),
      hostOwnership,
      sessionGarbageCollector: new RunnerSessionGarbageCollector(
        stateDirectory,
        options.env.SOUL_RUNNER_TERMINAL_RETENTION_MS,
        options.logger,
        undefined,
        recoveryStorage,
      ),
      closedTailDrainer: new ClosedRunnerTailDrainer({
        pumpMux: options.pumpMux,
        logger: options.logger,
      }),
      recoveryStorage,
    };
  } catch (error) {
    await closeRecoveryStorage(recoveryStorage);
    await hostOwnership.release();
    throw error;
  }
}

async function closeRecoveryStorage(storage: RunnerRecoveryStorage): Promise<void> {
  try {
    await storage.close();
  } catch {
    // Composition already failed; the original error remains authoritative.
  }
}

export async function composeRunnerRecoveryCoordinator(options: {
  env: Env;
  runnerProcessFactory?: RunnerProcessRuntimeFactory;
  releaseGarbageCollector?: Pick<RunnerReleaseGarbageCollector, "collect">;
  sessionGarbageCollector?: Pick<RunnerSessionGarbageCollector, "collect">;
  closedTailDrainer?: Pick<ClosedRunnerTailDrainer, "drain">;
  taskManager: Pick<
    TaskManager,
    | "hydrateRunnerRecoveryTask"
    | "markRunnerFailure"
    | "projectClosedRunner"
  >;
  taskExecutor: Pick<
    TaskExecutor,
    | "recoverRegisteredRunner"
    | "retainRegisteredDetachedRunner"
    | "releaseExpiredRetainedRunner"
    | "completeRetainedRunnerReleaseAfterTermination"
  >;
  terminalizeClaudeBackgroundTasks?: (
    sessionId: string,
    execution: ExecutionRegistration,
  ) => Promise<number>;
  logger: Logger;
  nodeStallMonitor?: Pick<NodeStallMonitor, "beginRunnerOperation">;
  recoveryStorage?: RunnerRecoveryStorage;
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
    nodeId: options.env.SOULSTREAM_NODE_ID,
    stateDirectory,
    leaseTimeoutMs: options.env.SOUL_RUNNER_LEASE_TIMEOUT_MS,
    scanIntervalMs: options.env.SOUL_RUNNER_REAPER_INTERVAL_MS,
    taskManager: options.taskManager,
    taskExecutor: options.taskExecutor,
    closedTailDrainer: options.closedTailDrainer,
    logger: options.logger,
    ...(options.nodeStallMonitor ? { nodeStallMonitor: options.nodeStallMonitor } : {}),
    ...(options.terminalizeClaudeBackgroundTasks
      ? {
        terminalizeClaudeBackgroundTasks:
          options.terminalizeClaudeBackgroundTasks,
      }
      : {}),
    ...(options.releaseGarbageCollector
      ? { releaseGarbageCollector: options.releaseGarbageCollector }
      : {}),
    ...(options.sessionGarbageCollector
      ? { sessionGarbageCollector: options.sessionGarbageCollector }
      : {}),
    ...(options.recoveryStorage ? { recoveryStorage: options.recoveryStorage } : {}),
  });
  return coordinator;
}

export function composeRunnerReconciliationReporter(
  env: Env,
  runnerProcessFactory: RunnerProcessRuntimeFactory | undefined,
  coordinator: RunnerRecoveryCoordinator | undefined,
  logger: Pick<Logger, "info" | "warn">,
  nodeStallMonitor?: Pick<NodeStallMonitor, "beginRunnerOperation">,
  recoveryStorage?: RunnerRecoveryStorage,
): Partial<RunnerReconciliationReporter> {
  if (!runnerProcessFactory) return {};
  const stateDirectory = env.SOUL_RUNNER_STATE_DIR;
  if (!stateDirectory || !coordinator) {
    throw new Error("runner inventory requires state directory and recovery coordinator");
  }
  const cache = new RunnerRegistrationScanCache();
  let inventorySequence = 0;
  return {
    listLiveRunnerSessionIds: async () => {
      const scopeId = `${env.SOULSTREAM_NODE_ID}:live-inventory:${++inventorySequence}`;
      const observation = createRunnerPhaseObservation({
        nodeId: env.SOULSTREAM_NODE_ID,
        scopeId,
        operation: "runner.upstream.liveInventory",
        logger,
        ...(nodeStallMonitor
          ? { beginRunnerOperation: nodeStallMonitor.beginRunnerOperation.bind(nodeStallMonitor) }
          : {}),
      });
      try {
        const sessionIds = await observation.runAsync("liveInventory", {}, async () =>
          await listLiveRunnerSessionIds({
            stateDirectory,
            cache,
            leaseTimeoutMs: env.SOUL_RUNNER_LEASE_TIMEOUT_MS,
            logger,
            phaseObservation: observation,
            ...(recoveryStorage ? { recoveryStorage } : {}),
          }));
        try {
          logger.info({
            nodeId: env.SOULSTREAM_NODE_ID,
            scanId: scopeId,
            phaseDurationsMs: observation.phaseDurationsMs(),
            database: observation.databaseSummary(),
            databaseAndPhaseDurationsOverlap: true,
          }, "runner upstream live inventory completed");
        } catch (error) {
          try {
            logger.warn({ err: error }, "runner phase observation failed");
          } catch {
            // Telemetry must not change the inventory result.
          }
        }
        return sessionIds;
      } catch (error) {
        const failure = observation.failureFor(error);
        try {
          logger.warn({
            nodeId: env.SOULSTREAM_NODE_ID,
            scanId: scopeId,
            ...(failure ? {
              failurePhase: failure.phase,
              failureElapsedMs: failure.elapsedMs,
            } : {}),
            phaseDurationsMs: observation.phaseDurationsMs(),
            database: observation.databaseSummary(),
            databaseAndPhaseDurationsOverlap: true,
          }, "runner upstream live inventory failed");
        } catch {
          // Preserve the original inventory failure if reporting also fails.
        }
        throw error;
      }
    },
    waitForRunnerReconciliation: async () => await coordinator.scanOnce(),
  };
}

/** 백그라운드 수명주기 관측기는 하나뿐이다. 없으면 옵션 자체를 두지 않는다. */
export function backgroundLifecycleObserver(
  lifecycle: ClaudeBackgroundTaskLifecycle | undefined,
): RunnerProcessRuntimeFactoryOptions["observeClaudeRuntime"] {
  if (!lifecycle) return undefined;
  return (sessionId, event, idempotencyKey, execution) =>
    lifecycle.observe(sessionId, event, idempotencyKey, execution);
}

function required(value: string | undefined, key: string): string {
  if (!value) throw new Error(`${key} required for runner process mode`);
  return value;
}
