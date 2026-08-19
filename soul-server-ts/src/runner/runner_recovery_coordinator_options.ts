import type { Logger } from "pino";

import type { TaskExecutor } from "../task/task_executor.js";
import type { TaskManager } from "../task/task_manager.js";
import type { ClosedRunnerTailDrainer } from "./closed_runner_tail_drainer.js";
import type { RunnerProcessSpawner } from "./runner_process_spawn.js";
import type {
  hydrateRunnerRegistration,
  RunnerRegistration,
  scanRunnerRegistrations,
} from "./runner_process_registry.js";
import type { quarantineUnreadableRunnerRegistration } from "./runner_registration_quarantine.js";
import type { RunnerReleaseGarbageCollector } from "./runner_release_gc.js";
import type { RunnerSessionGarbageCollector } from "./runner_session_gc.js";

export interface RunnerRecoveryCoordinatorOptions {
  nodeId: string;
  stateDirectory: string;
  leaseTimeoutMs: number;
  scanIntervalMs: number;
  taskManager: Pick<
    TaskManager,
    "hydrateRunnerRecoveryTask" | "markRunnerFailureAndResume"
      | "listOwnerNullRunningInventory"
  > & Partial<Pick<
    TaskManager,
    "projectClosedRunner" | "reconcileExecutionOwnershipObservations"
  >>;
  taskExecutor: Pick<
    TaskExecutor,
    "recoverRegisteredRunner" | "restartRegisteredRunner"
  >;
  closedTailDrainer: Pick<ClosedRunnerTailDrainer, "drain">;
  logger: Pick<Logger, "error" | "info" | "warn">;
  spawner?: Pick<RunnerProcessSpawner, "invalidateRegistration" | "terminate">;
  scan?: typeof scanRunnerRegistrations;
  hydrate?: typeof hydrateRunnerRegistration;
  refreshRegistration?: (
    registration: RunnerRegistration,
  ) => Promise<RunnerRegistration>;
  now?: () => number;
  monotonicNow?: () => number;
  markReaped?: (
    registration: RunnerRegistration,
    progressedAt: string,
    error: { code: string; message: string },
  ) => Promise<void>;
  releaseGarbageCollector?: Pick<RunnerReleaseGarbageCollector, "collect">;
  sessionGarbageCollector?: Pick<RunnerSessionGarbageCollector, "collect">;
  quarantineFailure?: typeof quarantineUnreadableRunnerRegistration;
  hydrationDeadlineMs?: number;
  hydrationConcurrency?: number;
}
