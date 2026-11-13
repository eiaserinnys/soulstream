import type { Logger } from "pino";

import type { TaskExecutor } from "../task/task_executor.js";
import type { TaskManager } from "../task/task_manager.js";
import type { ExecutionRegistration } from "../task/execution_registration.js";
import type { ClosedRunnerTailDrainer } from "./closed_runner_tail_drainer.js";
import type { RunnerProcessSpawner } from "./runner_process_spawn.js";
import type { RunnerCentralSessionRow } from "./runner_central_check.js";
import type { RunnerSettlementPendingProbe } from "./runner_registration_control.js";
import type {
  hydrateRunnerRegistration,
  RunnerRegistration,
  scanRunnerRegistrations,
} from "./runner_process_registry.js";
import type { quarantineUnreadableRunnerRegistration } from "./runner_registration_quarantine.js";
import type { RunnerReleaseGarbageCollector } from "./runner_release_gc.js";
import type { RunnerRecoveryStorage } from "./runner_recovery_storage.js";
import type { RunnerSessionGarbageCollector } from "./runner_session_gc.js";
import type { NodeStallMonitor } from "../runtime/node_stall_monitor.js";

export interface RunnerRecoveryCoordinatorOptions {
  nodeId: string;
  stateDirectory: string;
  leaseTimeoutMs: number;
  scanIntervalMs: number;
  taskManager: Pick<
    TaskManager,
    "hydrateRunnerRecoveryTask" | "markRunnerFailure"
  > & Partial<
    Pick<
      TaskManager,
      "projectClosedRunner" | "listTasks" | "forgetRunnerRecoveryTask"
    >
  >;
  taskExecutor: Pick<
    TaskExecutor,
    | "recoverRegisteredRunner"
    | "retainRegisteredDetachedRunner"
    | "releaseExpiredRetainedRunner"
    | "completeRetainedRunnerReleaseAfterTermination"
  > & Partial<Pick<TaskExecutor, "adoptAttachedRunnerExecution">>;
  /**
   * 중앙 세션 한 줄을 hydrate나 메모리 캐시 없이 읽는 포트다.
   * 없으면 중앙 확인을 하지 않는다.
   */
  readCentralSession?: (
    sessionId: string,
  ) => Promise<RunnerCentralSessionRow | null>;
  /**
   * 이 세션의 완료 정산 미결을 묻는 포트다. 미결이면 등록을 은퇴하지 않는다.
   * 운영 공급자는 늘 없음을 돌려준다(실제 영속은 카드 #1266).
   */
  hasPendingRunnerSettlement?: RunnerSettlementPendingProbe;
  closedTailDrainer: Pick<ClosedRunnerTailDrainer, "drain">;
  logger: Pick<Logger, "error" | "info" | "warn">;
  spawner?: Pick<
    RunnerProcessSpawner,
    "invalidateRegistration" | "retireTerminalRegistration" | "terminate"
  >;
  scan?: typeof scanRunnerRegistrations;
  hydrate?: typeof hydrateRunnerRegistration;
  refreshRegistration?: (
    registration: RunnerRegistration,
  ) => Promise<RunnerRegistration>;
  now?: () => number;
  monotonicNow?: () => number;
  nodeStallMonitor?: Pick<NodeStallMonitor, "beginRunnerOperation">;
  recoveryStorage?: RunnerRecoveryStorage;
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
  terminalizeClaudeBackgroundTasks?: (
    sessionId: string,
    execution: ExecutionRegistration,
  ) => Promise<number>;
}
