/**
 * TaskExecutor — Task 실행 흐름 (Phase B-3).
 * 500줄 예외: turn state machine의 단일 제어 경로를 보존한다. 이벤트 발행·종료 등
 * 독립 행위는 전용 모듈로 이미 추출되어 있다.
 *
 * 책임:
 *   1. EnginePort 인스턴스를 engineFactory(agent)로 생성
 *   2. task.runner 설정 (engine capability와 command dispatcher를 원자적으로 구성)
 *   3. engine.execute() AsyncIterable drain
 *   4. 매 yield 이벤트: 저장 대상은 persistEvent → emitEventEnvelope → handleSideEffects,
 *      wire-schema의 transient 분류는 영속화 없이 emitEventEnvelope → handleSideEffects
 *   5. session event 첫 yield: task.codexThreadId 박기
 *   6. 종료 시: terminal event + terminal_transition effect를 ACK barrier까지 반영
 *
 * Codex 단일턴 — _consumeEventStream이 generator 완료까지 drain하면 task 종료.
 * 멀티턴/idle 전환은 B-4.
 */

import type { Logger } from "pino";
import { randomUUID } from "node:crypto";

import type { AgentProfile } from "../agent_registry.js";
import type { ModelCatalog } from "../model_catalog.js";
import type { ProviderUsageCommandHandler } from "../auth/provider_usage.js";
import type {
  BackendId,
  EnginePort,
  ReasoningEffort,
  ScheduleToolUseHandler,
  SSEEventPayload,
  SupportsCompact,
} from "../engine/protocol.js";
import { makeContextUsagePayload } from "../engine/context_usage.js";
import type { EventPersistence } from "../db/event_persistence.js";
import type { SessionDB } from "../db/session_db.js";
import type { SessionMutationHost } from "../control_plane/persistence_host_clients.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";
import {
  readStoredPersistentSettings,
  type PersistentModelSelection,
} from "@soulstream/wire-schema/persistent-session-settings";
import type { ExecutionContextBuilder } from "../context/context_builder.js";
import {
  createInProcessTaskRunnerRuntime,
  createTaskRunnerRuntime,
  type TaskRunnerRuntime,
} from "../runner/task_runner_runtime.js";
import type { RunnerRegistration } from "../runner/runner_process_registry.js";
import { RunnerOrphanedSpawnError } from "../runner/runner_process_dispatcher.js";
import type { RunnerPhaseObservation } from "../runner/runner_phase_observation.js";
import { classifyRunnerAdoptRejection } from "./state/node_adopt_rejection.js";
import {
  ISOLATION_AUTH_UNAVAILABLE,
  ISOLATION_POLICY_UNAVAILABLE,
  ISOLATION_SHARED_DEPENDENCY_INODE,
  IsolationAuthUnavailableError,
  IsolationPreparationPolicyError,
  IsolationSharedDependencyInodeError,
  SESSION_ISOLATION_UNAVAILABLE,
  SessionIsolationUnavailableError,
  isolationPreparationFailureDetail,
} from "../runner/session_filesystem_errors.js";
import type { ExecutionSecurityDecision } from "../security/session_isolation_contract.js";
import {
  desiredRunnerIsolation,
  fullRunnerIsolation,
  runnerIsolationAllowsReuse,
  type RunnerIsolationIdentity,
  type SessionIsolationTurnGate,
} from "../security/session_isolation_turn.js";

import { assertGenericTaskExecution } from "./task_orchestration_purpose.js";
import type { CompletionNotifier } from "./completion_notifier.js";
import { TaskExecutorFinalizer } from "./task_executor_finalizer.js";
import { TaskEngineFailureRecovery } from "./task_engine_failure_recovery.js";
import { TaskAgentsSnapshotPersistence } from "./task_agents_snapshot_persistence.js";
import { TaskEngineEventPublisher } from "./task_engine_event_publisher.js";
import type { TransientEventLogAggregator } from "./transient_event_log_aggregator.js";
import { TaskEngineTurnRunner } from "./task_engine_turn_runner.js";
import { TaskInitialMessagePublisher } from "./task_initial_message_publisher.js";
import { applyCanonicalSessionProjection } from
  "./task_canonical_session_projection.js";
import { TaskLifecycleTransition } from "./task_lifecycle_transition.js";
import { releaseTaskRunner } from "./task_runner_release.js";
import {
  RunnerAdoptionRejectedError,
  type RunnerAdoptionApplication,
} from "./runner_adoption_rejected_error.js";
import {
  createExecutionActivation,
  isActiveTaskStatus,
  isTerminalTaskStatus,
  type ExecutionActivation,
  type InterventionMessage,
  type ObservedClaudeContextUsage,
  type Task,
  type TaskStatus,
} from "./task_models.js";
import { buildClaudeContextUsageMetadataEntry } from "./task_metadata.js";
import {
  dequeueInterventionsInLane,
  enqueueInterventionOnce,
  isRuntimeFollowup,
  rejoinUnstartedInterventions,
  removeInterventionMessage,
  sortInterventionsByPriority,
} from "./task_intervention_queue.js";
import {
  isOpenAiAgentsApprovalPending,
  resolveTurnLoopTransition,
  type TurnLoopTransitionDecision,
} from "./task_turn_loop_transition.js";
import {
  TaskTurnInputBuilder,
  TurnInputPreparationError,
  type TaskTurnInput,
} from "./task_turn_input_builder.js";
import { failBlockingClaudeRuntimeWork } from "./claude_runtime_state.js";
import {
  CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
  type ClaudeRuntimeTaskFollowupPort,
} from "./claude_runtime_task_followup.js";
import type { TaskDeliveryLedgerGate } from "./task_delivery_ledger_gate.js";
import type { PersistentSessionControl } from "./persistent_session_control.js";
import {
  SESSION_MODEL_FALLBACK_RESUME_PROMPT,
  type SessionModelFallbackTarget,
} from "./session_model_fallback.js";
import { SESSION_MODEL_FALLBACK_REASON } from "@soulstream/wire-schema/model-preset-fallbacks";
import type { SoulstreamScheduleService } from "../schedule/schedule_service.js";
import { TaskDeliveryConsumption } from "./task_delivery_consumption.js";
import { TaskDeliveryTurnReceipt } from "./task_delivery_turn_receipt.js";
import {
  decidePersistentGeneration,
  type DecisionTrigger,
} from "./persistent_decision.js";
import { isCacheKeepaliveInput } from "./persistent_keepalive_marker.js";
import {
  buildPersistentDecisionInput,
  completeEventEndedAt,
} from "./persistent_decision_input.js";
import type { ClaudeBackgroundConsumptionProof } from
  "./claude_background_result_consumption.js";
import {
  applyModelPresetRuntime,
  effectiveTaskBackend,
} from "./task_model_preset.js";
import {
  beginGenerationRolloverIfPending,
  reconcileGenerationBeforeExecution,
  commitStart as commitGenerationStart,
  complete as completeGenerationRollover,
  persistUnavailablePresetFailure,
  publishStarted as publishGenerationStarted,
} from "./persistent_generation_rollover.js";
import {
  isCompleteRunnerExecutionIdentity,
  type RunnerTerminalFact,
} from "./execution_registration.js";
import {
  CLAUDE_BACKEND_ROLLOVER_LIMIT,
  claudeBackendRolloverMetadataEntry,
  createClaudeContextRecoveryObservation,
  estimateClaudeTurnInputTokens,
  fatalPromptTooLongEvent,
  observeClaudeContextRecoveryEvent,
  shouldPreemptivelyCompact,
} from "./claude_context_recovery.js";
import type { PrepareAttachmentInput } from "./prepare_attachment_input.js";

const CLAUDE_RUNTIME_PENDING_AFTER_TURN_MESSAGE = "Claude runtime session remained active after the engine turn ended; marking this turn failed so follow-up messages can resume.";

/** AgentProfile → EnginePort 생성. backend별 분기는 factory 구현체 담당. */
export type EngineFactory = (
  agent: AgentProfile,
  backendOverride?: BackendId,
) => EnginePort;

export interface RunnerProcessRuntimeFactory {
  (
    task: Task,
    agent: AgentProfile,
    backend: BackendId,
    snapshots: RunnerSnapshotPersistence,
  ): TaskRunnerRuntime;
  /**
   * 이 팩토리가 restricted 실행을 실제로 준비할 수 있는지. 미설정/false면
   * restricted 턴은 full로 내려가지 않고 `SESSION_ISOLATION_UNAVAILABLE`로
   * 실패한다(fail-closed). full 턴에는 영향이 없다.
   */
  isolationSupported?: boolean;
  recover?(
    task: Task,
    registration: RunnerRegistration,
    snapshots: RunnerSnapshotPersistence,
    mode?: "adopt" | "replay" | "offline",
    phaseObservation?: RunnerPhaseObservation,
  ): TaskRunnerRuntime;
}

interface RecoveredRunnerTerminalObservation {
  fact: RunnerTerminalFact;
  detail: string | null;
}

/**
 * 잇기 거절로 소비를 멈춘 프레임 통로다.
 *
 * 다시 될 수 있는 거절은 러너를 붙인 채 둔다. 프레임 통로는 프레임마다
 * 확인(ack)을 받아야 아이가 다음 프레임으로 넘어가므로, 소비를 영영 멈추면
 * 나중에 잇기가 적용돼도 그 턴의 출력이 서버로 오지 않는다. 붙인 러너에
 * 잇기 전이만 다시 보내는 길이 적용을 받으면 이 통로를 이어서 소비한다.
 */
interface SuspendedRecoveredExecution {
  agent: AgentProfile;
  runner: TaskRunnerRuntime;
  frames: AsyncIterable<import("../runner/frame_protocol.js").RunnerEventFrame>;
  terminalObservation?: RecoveredRunnerTerminalObservation;
}

function recoveredRunnerTerminalObservation(
  registration: RunnerRegistration,
): RecoveredRunnerTerminalObservation | undefined {
  const lifecycle = registration.lifecycle;
  if (!lifecycle || lifecycle.execution_state === "running") return undefined;
  return {
    fact: lifecycle.execution_state,
    detail: lifecycle.terminal_error?.message ?? null,
  };
}

/**
 * 격리 판정 포트가 던진 오류를 턴 실패 경로가 그대로 기록하는 형태로 바꾼다.
 * 실패 경로는 `error.message`만 저장하므로 코드를 메시지 앞에 붙여 남긴다.
 */
function isolateGateFailure(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  switch ((error as { code?: unknown } | null)?.code) {
    case ISOLATION_AUTH_UNAVAILABLE:
      return new IsolationAuthUnavailableError(`${ISOLATION_AUTH_UNAVAILABLE}: ${message}`, error);
    case ISOLATION_POLICY_UNAVAILABLE:
      return new IsolationPreparationPolicyError(
        `${ISOLATION_POLICY_UNAVAILABLE}: ${message}`,
        error,
      );
    case ISOLATION_SHARED_DEPENDENCY_INODE:
      return new IsolationSharedDependencyInodeError(
        `${ISOLATION_SHARED_DEPENDENCY_INODE}: ${message}`,
        error,
      );
    case SESSION_ISOLATION_UNAVAILABLE:
      return new SessionIsolationUnavailableError(
        `${SESSION_ISOLATION_UNAVAILABLE}: ${message}`,
        error,
      );
    default:
      return error instanceof Error ? error : new Error(message);
  }
}

export interface RunnerSnapshotPersistence {
    persistRunState(
      snapshot: import("../engine/protocol.js").EngineRunStateSnapshot,
      idempotencyKey?: string,
    ): Promise<void>;
    persistSessionItems(
      snapshot: import("../engine/protocol.js").EngineSessionItemsSnapshot,
      idempotencyKey?: string,
    ): Promise<void>;
}

export interface WorktreeExecutionResolver {
  resolveExecutionWorkspace(worktreeId: string): Promise<string>;
}

/**
 * Reads the profile's original workspace from the agent registry.
 *
 * A resumed task's agent snapshot may already carry the attached worktree path
 * as its `workspace_dir`, so it cannot answer this. The isolation plan's host
 * root must be the profile workspace even when the execution cwd is a worktree.
 */
export interface ProfileWorkspaceResolver {
  resolveProfileWorkspace(profileId: string): string | undefined;
}

/**
 * 일반 세션의 실행 중 한도 전환 포트. 미주입이면 이 기능은 동작하지 않는다
 * (legacy 호출자와 테스트 환경 호환).
 */
export interface SessionModelFallbackRuntime {
  chooseTarget(task: Task): Promise<SessionModelFallbackTarget | null>;
  persistentSessions: Pick<
    PersistentSessionControl,
    "requestSessionModelFallbackRollover" | "cancelPendingGenerationRollover"
  >;
  scheduleService: Pick<SoulstreamScheduleService, "scheduleResumeAfterLimit">;
}

interface PersistentDecisionRuntime {
  persistentSessions: Pick<PersistentSessionControl, "requestGenerationRollover">;
  providerUsage: ProviderUsageCommandHandler;
  scheduleService: Pick<
    SoulstreamScheduleService,
    "deleteCacheKeepaliveSchedules" | "scheduleCacheKeepalive" | "scheduleResumeAfterLimit"
  >;
}

export class TaskExecutor {
  private readonly engineEventPublisher: TaskEngineEventPublisher;
  private readonly engineFailureRecovery: TaskEngineFailureRecovery;
  private readonly lifecycleTransition: TaskLifecycleTransition;
  private readonly executorFinalizer: TaskExecutorFinalizer;
  private readonly initialMessagePublisher: TaskInitialMessagePublisher;
  private readonly agentsSnapshotPersistence: TaskAgentsSnapshotPersistence;
  private readonly engineTurnRunner: TaskEngineTurnRunner;
  private readonly turnInputBuilder: TaskTurnInputBuilder;
  private readonly deliveryConsumption?: TaskDeliveryConsumption;
  private readonly suspendedRecoveredExecutions =
    new WeakMap<Task, SuspendedRecoveredExecution>();
  constructor(
    private readonly engineFactory: EngineFactory,
    private readonly db: SessionDB,
    private readonly persistence: EventPersistence,
    broadcaster: SessionBroadcaster,
    private readonly logger: Logger,
    /**
     * B-6 context_builder DI. undefined일 때 본 PR 이전 동작(task.prompt 직접 사용) 유지 —
     * legacy 호출자·테스트 환경 호환. 운영 흐름(main.ts)에서는 항상 주입.
     */
    contextBuilder?: ExecutionContextBuilder,
    /**
     * B-7 피위임 완료 회송. undefined일 때 통지 skip — legacy 호출자·테스트 환경 호환.
     * 운영 흐름(main.ts)에서는 항상 주입하여 child finalize 후 parent에게 결과 텍스트 송신.
     *
     * Legacy caller completion notification 정본의 codex 적응판 (분석 캐시
     * `roselin/.local/artifacts/analysis/20260518-2125-ts-delegation-return.md` §3-2).
     */
    completionNotifier?: CompletionNotifier,
    scheduleToolHandler?: ScheduleToolUseHandler,
    private readonly claudeRuntimeTaskFollowup?: ClaudeRuntimeTaskFollowupPort,
    deliveryConsumptionRecorder?: Pick<
      TaskDeliveryLedgerGate,
      | "recordConsumed"
      | "recordTurnStarted"
      | "discardIfConsumed"
      | "recordConsumptionFailure"
      | "recordAdmissionFailure"
      | "recordRuntimeFollowupRelationConsumed"
    >,
    private readonly modelCatalog?: Pick<ModelCatalog, "resolve" | "snapshot">,
    private readonly runnerProcessFactory?: RunnerProcessRuntimeFactory,
    transientEventLogAggregator?: TransientEventLogAggregator,
    private readonly queuedTerminalResume?: (task: Task) => void | Promise<void>,
    private readonly worktreeResolver?: WorktreeExecutionResolver,
    private readonly sessionMutations?: Pick<SessionMutationHost, "setModelSelection">,
    private readonly persistentDecisionRuntime?: PersistentDecisionRuntime,
    private readonly waitForAttachmentRefs?: (sessionId: string) => Promise<unknown>,
    private readonly prepareAttachmentInput?: PrepareAttachmentInput,
    private readonly claudeAccountPoolEnabled = false,
    /**
     * 약한 모델 세션 격리 판정 포트. `SESSION_ISOLATION_MODE=off`면 undefined로
     * 주입되어 판정 호출이 0회다. enforce일 때만 CLI 세션 턴마다 정확히 한 번
     * `resolveDecision`을 부른다.
     */
    private readonly sessionIsolation?: SessionIsolationTurnGate,
    private readonly profileWorkspaceResolver?: ProfileWorkspaceResolver,
    /** 일반 세션 실행 중 한도 전환. 미주입이면 동작하지 않는다. */
    private readonly sessionModelFallbackRuntime?: SessionModelFallbackRuntime,
    /** 클로드 백그라운드 보유 상한. 넘기면 보유를 풀고 부른 세션에 알린다. */
    backgroundRetentionCapMs?: number,
  ) {
    this.lifecycleTransition = new TaskLifecycleTransition({
      logger: this.logger,
      persistence,
      completionNotifier,
    });
    this.executorFinalizer = new TaskExecutorFinalizer({
      lifecycleTransition: this.lifecycleTransition,
      logger: this.logger,
      notifyBackgroundStopped: async (task, firstSentence) => {
        await this.lifecycleTransition.notifyBackgroundStopped(task, firstSentence);
      },
      ...(backgroundRetentionCapMs !== undefined ? { retentionCapMs: backgroundRetentionCapMs } : {}),
    });
    this.engineEventPublisher = new TaskEngineEventPublisher({
      broadcaster,
      logger: this.logger,
      persistence,
      ...(transientEventLogAggregator ? { transientEventLogAggregator } : {}),
    });
    this.engineFailureRecovery = new TaskEngineFailureRecovery({
      logger: this.logger,
    });
    this.initialMessagePublisher = new TaskInitialMessagePublisher({
      broadcaster,
      logger: this.logger,
      persistence,
    });
    this.turnInputBuilder = new TaskTurnInputBuilder({
      contextBuilder,
      initialMessagePublisher: this.initialMessagePublisher,
      logger: this.logger,
      ...(this.prepareAttachmentInput
        ? { prepareAttachmentInput: this.prepareAttachmentInput }
        : {}),
      ...(this.waitForAttachmentRefs
        ? { waitForAttachmentRefs: this.waitForAttachmentRefs }
        : {}),
    });
    this.agentsSnapshotPersistence = new TaskAgentsSnapshotPersistence({
      persistence,
      logger: this.logger,
    });
    this.engineTurnRunner = new TaskEngineTurnRunner({
      snapshotPersistence: this.agentsSnapshotPersistence,
      scheduleToolHandler,
      modelCatalog: this.modelCatalog,
      claudeAccountPoolEnabled: this.claudeAccountPoolEnabled,
    });
    this.deliveryConsumption = deliveryConsumptionRecorder
      ? new TaskDeliveryConsumption(deliveryConsumptionRecorder, this.logger)
      : undefined;
  }

  /**
   * Task 실행 시작. fire-and-forget — 호출자가 *await하지 않는다*.
   *
   * task.executionPromise에 drain promise를 박아 *후속 shutdown/cancel*이 drain 가능.
   * promise 실패는 task.error에 박히고 status="error"로 전환.
   */
  startNewExecution(
    task: Task,
    agent: AgentProfile,
    activation?: ExecutionActivation,
  ): Promise<void> {
    assertGenericTaskExecution(task, agent.id);
    // Any actual execution start (explicit retry or a new delivery) reopens the
    // drain that a preparation failure closed.
    task.queuedTerminalResumeBlocked = undefined;
    const releaseClaim = task.runnerReleaseClaim;
    if (releaseClaim) {
      return this.startExecutionAfterRunnerReleaseClaim(
        task,
        agent,
        activation,
        releaseClaim,
      );
    }
    return this.startExecutionWithRegistrationRecord(task, agent, activation);
  }

  private async startExecutionAfterRunnerReleaseClaim(
    task: Task,
    agent: AgentProfile,
    activation: ExecutionActivation | undefined,
    firstClaim: NonNullable<Task["runnerReleaseClaim"]>,
  ): Promise<void> {
    let claim: Task["runnerReleaseClaim"] = firstClaim;
    while (claim) {
      await claim.completion;
      claim = task.runnerReleaseClaim;
    }
    return await this.startExecutionWithRegistrationRecord(task, agent, activation);
  }

  private startExecutionWithRegistrationRecord(
    task: Task,
    agent: AgentProfile,
    transferredActivation?: ExecutionActivation,
  ): Promise<void> {
    if (!task.worktreeId) {
      task.resolvedWorkspaceDir = undefined;
      task.profileWorkspaceDir = undefined;
      return this.startExecutionWithResolvedRegistrationRecord(
        task,
        agent,
        transferredActivation,
      );
    }
    if (!this.worktreeResolver) {
      throw new Error(`WORKTREE_UNAVAILABLE: resolver missing for ${task.worktreeId}`);
    }
    if (
      task.executionPromise
      || (task.executionActivation && task.executionActivation !== transferredActivation)
    ) {
      throw new Error(
        `Task ${task.agentSessionId} already has an execution admission in flight`,
      );
    }
    const profileWorkspaceDir = this.resolveProfileWorkspaceDir(agent);
    if (!profileWorkspaceDir) {
      const unavailable = new ProfileWorkspaceUnavailableError(
        `${agent.id} (${task.agentSessionId})`,
      );
      if (transferredActivation) {
        task.executionActivation = transferredActivation;
        void transferredActivation.promise.catch(() => undefined);
      }
      return this.holdExecutionSlot(
        task,
        this.handleExecutionFailure(task, transferredActivation, unavailable),
      );
    }
    const promise = this.resolveWorktreeAndStartExecution(
      task,
      agent,
      task.worktreeId,
      this.worktreeResolver,
      transferredActivation,
      profileWorkspaceDir,
    );
    return this.holdExecutionSlot(task, promise);
  }

  private resolveProfileWorkspaceDir(agent: AgentProfile): string | undefined {
    if (!this.profileWorkspaceResolver) return agent.workspace_dir;
    return this.profileWorkspaceResolver.resolveProfileWorkspace(agent.id);
  }

  private async resolveWorktreeAndStartExecution(
    task: Task,
    agent: AgentProfile,
    worktreeId: string,
    worktreeResolver: WorktreeExecutionResolver,
    transferredActivation: ExecutionActivation | undefined,
    profileWorkspaceDir: string,
  ): Promise<void> {
    let workspaceDir: string;
    try {
      workspaceDir = await worktreeResolver.resolveExecutionWorkspace(worktreeId);
    } catch (error) {
      task.resolvedWorkspaceDir = undefined;
      const unavailable = new Error(
        `WORKTREE_UNAVAILABLE: ${worktreeId}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
      const activation = transferredActivation;
      if (activation) {
        task.executionActivation = activation;
        void activation.promise.catch(() => undefined);
      }
      await this.handleExecutionFailure(task, activation, unavailable);
      return;
    }
    task.resolvedWorkspaceDir = workspaceDir;
    // 아래에서 agent를 워크트리 경로로 치환하기 전의 프로필 경로를 남긴다.
    // 격리 계획의 hostWorkspaceRoot는 이 값을 쓴다. 복원 경로의 agent는
    // 이미 워크트리 경로이므로 여기서 agent.workspace_dir을 쓰면 안 된다.
    task.profileWorkspaceDir = profileWorkspaceDir;
    return await this.startExecutionWithResolvedRegistrationRecord(
      task,
      { ...agent, workspace_dir: workspaceDir },
      transferredActivation,
      true,
    );
  }

  private startExecutionWithResolvedRegistrationRecord(
    task: Task,
    agent: AgentProfile,
    transferredActivation?: ExecutionActivation,
    executionSlotHeld = false,
  ): Promise<void> {
    if (
      (!executionSlotHeld && task.executionPromise)
      || (task.executionActivation && task.executionActivation !== transferredActivation)
    ) {
      throw new Error(
        `Task ${task.agentSessionId} already has an execution admission in flight`,
      );
    }
    let prepared: ReturnType<TaskExecutor["prepareExecution"]>;
    try {
      prepared = this.prepareExecution(task, agent);
    } catch (error) {
      if (!transferredActivation) throw error;
      task.executionActivation = transferredActivation;
      void transferredActivation.promise.catch(() => undefined);
      const promise = this.handleExecutionFailure(task, transferredActivation, error);
      return executionSlotHeld ? promise : this.holdExecutionSlot(task, promise);
    }

    const shouldDecideArrival = this.shouldDecidePersistentArrival(task);
    const applyingFrom = task.persistentGeneration?.pending?.applyingFrom;
    const needsGenerationReconciliation = applyingFrom !== undefined
      && task.codexThreadId !== applyingFrom;
    if (!shouldDecideArrival && !needsGenerationReconciliation) {
      beginGenerationRolloverIfPending(task, agent, this.modelCatalog, this.logger);
      return this.startPreparedExecution(
        task,
        agent,
        prepared,
        effectiveTaskBackend(task, agent),
        transferredActivation,
        executionSlotHeld,
      );
    }

    const activation = this.supportsExecutionRegistration()
      ? transferredActivation ?? createExecutionActivation()
      : transferredActivation;
    if (activation) {
      task.executionActivation = activation;
      void activation.promise.catch(() => undefined);
    }

    const execution = (async () => {
      try {
        if (shouldDecideArrival) await this.decidePersistentArrival(task);
        await reconcileGenerationBeforeExecution(task, this.persistence);
        beginGenerationRolloverIfPending(task, agent, this.modelCatalog, this.logger);
        await this.startPreparedExecution(
          task,
          agent,
          prepared,
          effectiveTaskBackend(task, agent),
          activation,
          true,
        );
      } catch (error) {
        await this.handleExecutionFailure(task, activation, error);
      }
    })();
    return executionSlotHeld ? execution : this.holdExecutionSlot(task, execution);
  }

  private startPreparedExecution(
    task: Task,
    agent: AgentProfile,
    prepared: ReturnType<TaskExecutor["prepareExecution"]>,
    backend: BackendId,
    transferredActivation: ExecutionActivation | undefined,
    executionSlotHeld: boolean,
  ): Promise<void> {
    if (!this.supportsExecutionRegistration()) {
      return this.startExecutionWithoutRegistration(
        task,
        agent,
        backend,
        prepared.retainedRunner,
        transferredActivation,
        executionSlotHeld,
      );
    }

    const activation = transferredActivation ?? createExecutionActivation();
    task.executionActivation = activation;
    void activation.promise.catch(() => undefined);
    const releaseActivation = (): void => {
      if (task.executionActivation === activation) task.executionActivation = undefined;
    };
    const promise = this.startRecordedExecution(
      task,
      agent,
      backend,
      prepared.retainedRunner,
      () => {
        activation.resolve();
        releaseActivation();
      },
    ).catch(async (err: unknown) => {
      if (err instanceof RunnerOrphanedSpawnError) {
        await activation.reject(err);
        releaseActivation();
        this.logger.error(
          { err, sessionId: task.agentSessionId, proof: err.proof },
          "Spawned runner parent initialization failed; recovery owns the live child",
        );
        return;
      }
      releaseActivation();
      if (isTerminalTaskStatus(task.status)) {
        await activation.reject(err);
        return;
      }
      await this.handleExecutionFailure(task, activation, err);
    });
    return executionSlotHeld ? promise : this.holdExecutionSlot(task, promise);
  }

  private prepareExecution(
    task: Task,
    agent: AgentProfile,
  ): { retainedRunner: TaskRunnerRuntime | undefined } {
    const retainedRunner = task.runnerRetainedForDetachedWork === true
      ? task.runner
      : undefined;
    if (task.runner && !retainedRunner) {
      throw new Error(
        `Task ${task.agentSessionId} already has a runner — concurrent execute not supported`,
      );
    }
    const presetRuntime = applyModelPresetRuntime(task, agent, this.modelCatalog);
    if (presetRuntime === "preset_unavailable") {
      this.logger.warn(
        {
          sessionId: task.agentSessionId,
          modelPreset: task.modelPreset,
          fallbackBackend: agent.backend,
          profileEnvFallback: agent.env !== undefined,
        },
        "Persisted model preset is unavailable; using the profile backend",
      );
    }
    return { retainedRunner };
  }

  private shouldDecidePersistentArrival(task: Task): boolean {
    if (!this.persistentDecisionRuntime || !this.modelCatalog || task.persistent !== true) {
      return false;
    }
    if (
      hasUnappliedOrNonArrivalPendingGeneration(task)
      || task.runnerRetainedForDetachedWork === true
      || !task.codexThreadId
    ) return false;
    const firstIntervention = sortInterventionsByPriority(task.interventionQueue)[0];
    return !!firstIntervention
      && !isRuntimeFollowup(firstIntervention)
      && !isCacheKeepaliveInput(firstIntervention);
  }

  private async decidePersistentArrival(task: Task): Promise<void> {
    const runtime = this.persistentDecisionRuntime;
    if (!runtime || !this.modelCatalog || task.persistent !== true) return;
    if (
      hasUnappliedOrNonArrivalPendingGeneration(task)
      || task.runnerRetainedForDetachedWork === true
      || !task.codexThreadId
    ) return;
    const firstIntervention = sortInterventionsByPriority(task.interventionQueue)[0];
    if (!firstIntervention || isRuntimeFollowup(firstIntervention)) return;
    if (isCacheKeepaliveInput(firstIntervention)) return;

    const now = new Date();
    let decision;
    try {
      const input = await buildPersistentDecisionInput(
        { task, trigger: "arrival", now },
        {
          db: this.db,
          modelCatalog: this.modelCatalog,
          providerUsage: runtime.providerUsage,
          logger: this.logger,
        },
      );
      decision = decidePersistentGeneration(input);
    } catch (err) {
      this.logger.warn(
        { sessionId: task.agentSessionId, trigger: "arrival", err },
        "persistent decision skipped",
      );
      return;
    }
    await this.recordPersistentDecision(task, "arrival", decision);
    if (decision.action !== "new_generation" || !decision.target_preset) return;

    const targetSelection = persistentSelectionForTarget(
      task,
      decision.target_preset,
      this.modelCatalog?.snapshot().persistent_defaults.fallback_models ?? [],
    );
    const reasoningEffort = targetSelection?.reasoning_effort;
    const existingPending = task.persistentGeneration?.pending;
    if (
      existingPending?.applyingFrom !== undefined
      && existingPending.targetModelPreset === decision.target_preset
      && existingPending.targetReasoningEffort === (reasoningEffort as ReasoningEffort | undefined)
    ) return;
    await runtime.persistentSessions.requestGenerationRollover(task.agentSessionId, {
      modelPreset: decision.target_preset,
      ...(reasoningEffort ? { reasoningEffort: reasoningEffort as ReasoningEffort } : {}),
      reason: `auto:${decision.rule}`,
    });
  }

  private async decidePersistentTurnEnd(
    task: Task,
    completeEvent: SSEEventPayload,
    interventions: readonly InterventionMessage[],
  ): Promise<void> {
    const runtime = this.persistentDecisionRuntime;
    if (!runtime || !this.modelCatalog || task.persistent !== true) return;

    const now = new Date();
    let decision;
    try {
      const input = await buildPersistentDecisionInput(
        {
          task,
          trigger: "turn_end",
          now,
          ...(completeEventEndedAt(completeEvent)
            ? { lastCallEndedAt: completeEventEndedAt(completeEvent) }
            : {}),
        },
        {
          db: this.db,
          modelCatalog: this.modelCatalog,
          providerUsage: runtime.providerUsage,
          logger: this.logger,
        },
      );
      decision = decidePersistentGeneration(input);
    } catch (err) {
      this.logger.warn(
        { sessionId: task.agentSessionId, trigger: "turn_end", err },
        "persistent decision skipped",
      );
      return;
    }
    const keepaliveResult = keepaliveResultFor(completeEvent, interventions);
    await this.recordPersistentDecision(task, "turn_end", decision, keepaliveResult);
    await runtime.scheduleService.deleteCacheKeepaliveSchedules(task.agentSessionId);
    if (decision.action === "schedule_keepalive" && decision.wake_at) {
      await runtime.scheduleService.scheduleCacheKeepalive(
        task.agentSessionId,
        decision.wake_at,
        now,
      );
    }
  }

  private async decidePersistentLimitHit(task: Task): Promise<void> {
    const runtime = this.persistentDecisionRuntime;
    if (
      !runtime
      || !this.modelCatalog
      || task.persistent !== true
      || task.terminationReason !== "limit_hit"
    ) return;

    const now = new Date();
    const limitResetAt = task.rateLimitStopInfo?.resetsAt;
    let decision;
    try {
      const input = await buildPersistentDecisionInput(
        {
          task,
          trigger: "limit_hit",
          now,
          ...(limitResetAt !== undefined ? { limitResetAt } : {}),
        },
        {
          db: this.db,
          modelCatalog: this.modelCatalog,
          providerUsage: runtime.providerUsage,
          logger: this.logger,
        },
      );
      decision = decidePersistentGeneration(input);
    } catch (err) {
      this.logger.warn(
        { sessionId: task.agentSessionId, trigger: "limit_hit", err },
        "persistent decision skipped",
      );
      return;
    }
    await this.recordPersistentDecision(task, "limit_hit", decision);

    if (decision.action === "new_generation" && decision.target_preset) {
      const targetSelection = persistentSelectionForTarget(
        task,
        decision.target_preset,
        this.modelCatalog?.snapshot().persistent_defaults.fallback_models ?? [],
      );
      const reasoningEffort = targetSelection?.reasoning_effort;
      await runtime.persistentSessions.requestGenerationRollover(task.agentSessionId, {
        modelPreset: decision.target_preset,
        ...(reasoningEffort ? { reasoningEffort: reasoningEffort as ReasoningEffort } : {}),
        reason: `auto:${decision.rule}`,
      });
    }

    const scheduleAt = decision.action === "new_generation"
      ? now
      : decision.action === "wait_until" && decision.wake_at
        ? new Date(decision.wake_at)
        : undefined;
    if (scheduleAt && task.terminalEventId !== undefined) {
      const scheduleArgs = [task.agentSessionId, task.terminalEventId, scheduleAt, now] as const;
      if (decision.action === "new_generation") {
        await runtime.scheduleService.scheduleResumeAfterLimit(
          ...scheduleArgs,
          "사용 가능한 대체 모델로 이전 지시와 미완료 작업을 이어서 진행해주세요.",
        );
      } else {
        await runtime.scheduleService.scheduleResumeAfterLimit(...scheduleArgs);
      }
    }
  }

  private async recordPersistentDecision(
    task: Task,
    trigger: DecisionTrigger,
    decision: ReturnType<typeof decidePersistentGeneration>,
    keepaliveResult?: {
      input_tokens: number;
      cached_input_tokens: number;
      cache_hit: boolean;
    },
  ): Promise<void> {
    const event = {
      type: "debug",
      kind: "persistent_decision",
      trigger,
      action: decision.action,
      ...(decision.target_preset ? { target_preset: decision.target_preset } : {}),
      ...(decision.wake_at ? { wake_at: decision.wake_at } : {}),
      rule: decision.rule,
      reason: decision.reason,
      inputs_snapshot: decision.inputs_snapshot,
      ...(keepaliveResult ? { keepalive_result: keepaliveResult } : {}),
      timestamp: Date.now() / 1_000,
    } as unknown as SSEEventPayload;
    try {
      await this.persistence.enqueueEvent(
        task.agentSessionId,
        event,
        undefined,
        task.executionRegistration?.registrationId,
      );
    } catch {
      this.logger.warn(
        { sessionId: task.agentSessionId, trigger, failureKind: "record" },
        "persistent decision record skipped",
      );
    }
  }

  private async takeOrCreateRunner(
    task: Task,
    agent: AgentProfile,
    backend: BackendId,
    retainedRunner: TaskRunnerRuntime | undefined,
  ): Promise<TaskRunnerRuntime> {
    const desiredIsolation = await this.resolveRunnerIsolation(task);
    let reusableRunner = retainedRunner;
    if (reusableRunner && (
      reusableRunner.engine.backendId !== backend
      || !runnerIsolationAllowsReuse(reusableRunner.isolation, desiredIsolation)
    )) {
      await reusableRunner.dispatcher.close();
      releaseTaskRunner(task, reusableRunner);
      reusableRunner = undefined;
    }
    if (!reusableRunner && desiredIsolation.tier === "restricted"
      && this.runnerProcessFactory?.isolationSupported !== true) {
      // restricted는 격리를 실제로 준비하는 러너 프로세스 경로 전용이다.
      // 준비 능력이 없으면 in-process로도, 일반 러너로도 내려가지 않는다.
      throw new SessionIsolationUnavailableError(
        `${SESSION_ISOLATION_UNAVAILABLE}: restricted execution requires an isolation-capable runner process path`,
      );
    }
    let runner = reusableRunner ?? (this.runnerProcessFactory
      ? this.runnerProcessFactory(task, agent, backend, this.snapshotPersistenceFor(task))
      : createInProcessTaskRunnerRuntime(
          task.modelPresetBackend
            ? this.engineFactory(agent, backend)
            : this.engineFactory(agent),
        ));
    if (reusableRunner) releaseTaskRunner(task, reusableRunner);
    if (!runner.isolation && desiredIsolation.tier === "restricted") {
      runner = createTaskRunnerRuntime(
        runner.engine,
        runner.dispatcher,
        runner.eventPersistence,
        desiredIsolation,
      );
    }
    return runner;
  }

  /**
   * 이번 턴의 격리 판정과 러너 재사용 기준. off(포트 미주입)와 LLM 세션은
   * 판정 호출 0회다. enforce + CLI 세션이면 정확히 한 번 부른다.
   */
  private async resolveRunnerIsolation(task: Task): Promise<RunnerIsolationIdentity> {
    const gate = this.sessionIsolation;
    if (!gate) return fullRunnerIsolation();
    if ((task.sessionType ?? "claude") !== "claude") {
      task.executionSecurity = undefined;
      return fullRunnerIsolation();
    }
    let decision: ExecutionSecurityDecision | null;
    try {
      decision = await gate.resolveDecision(
        task.agentSessionId,
        task.modelPreset ?? null,
      );
    } catch (error) {
      throw isolateGateFailure(error);
    }
    task.executionSecurity = decision ?? undefined;
    if (decision?.tier !== "restricted") return fullRunnerIsolation();
    let attachedWorktreeIds: readonly string[];
    try {
      attachedWorktreeIds = await gate.worktreeAttachmentIds(
        task.agentSessionId,
        task.worktreeId,
      );
    } catch (error) {
      throw isolateGateFailure(error);
    }
    return desiredRunnerIsolation(decision, gate.policyDigest(), attachedWorktreeIds);
  }

  private startExecutionWithoutRegistration(
    task: Task,
    agent: AgentProfile,
    backend: BackendId,
    retainedRunner: TaskRunnerRuntime | undefined,
    activation?: ExecutionActivation,
    executionSlotHeld = false,
  ): Promise<void> {
    const execution = (async () => {
      let runner: TaskRunnerRuntime;
      try {
        runner = await this.takeOrCreateRunner(task, agent, backend, retainedRunner);
      } catch (error) {
        await this.handleExecutionFailure(task, activation, error);
        return;
      }
      await this.startExecutionWithRunner(task, agent, runner, activation, true);
    })();
    return executionSlotHeld ? execution : this.holdExecutionSlot(task, execution);
  }

  /**
   * Holds the task's execution slot for exactly as long as the execution runs.
   *
   * Recovery, intervention routing and auto-resume all read a present
   * `task.executionPromise` as "an execution is in flight". Nothing ever
   * cleared it when one finished, so a settled promise went on standing in for
   * a live execution: the offline replay of a finished runner turn was refused
   * for as long as the task stayed in memory, and that turn's output never
   * reached the user (260822 outage; lab scenario F9 logs
   * `blockedBy=execution_promise` on the replay it refused).
   *
   * Waiters are unaffected. Every reader either awaits the slot to drain -- and
   * an absent slot has already drained -- or asks whether an execution is
   * running, which is now the question the field actually answers.
   */
  private holdExecutionSlot(task: Task, promise: Promise<void>): Promise<void> {
    task.executionPromise = promise;
    const release = (): void => {
      if (task.executionPromise !== promise) return;
      task.executionPromise = undefined;
      void this.driveQueuedAfterTerminal(task);
    };
    void promise.then(release, release);
    return promise;
  }

  /**
   * Routes an execution-start failure to the one terminal outcome that owns it.
   *
   * A deterministic preparation failure (isolation policy, profile workspace)
   * fails identically on every retry. Restoring the previous terminal snapshot
   * would make the queued-input drain resume it forever, so this failure closes
   * its own input and becomes this attempt's error terminal instead.
   */
  private async handleExecutionFailure(
    task: Task,
    activation: ExecutionActivation | undefined,
    error: unknown,
  ): Promise<void> {
    const preparationFailure = executionPreparationFailure(error);
    const restsOnPriorTerminal = preparationFailure === undefined
      && activation?.hasFailureCompensation?.() === true;
    try {
      if (restsOnPriorTerminal) {
        await activation?.reject(error);
        if (isTerminalTaskStatus(task.status)) return;
      }
      if (preparationFailure?.interventions !== undefined) {
        this.clearPrematureUnknownTermination(task);
      }
      // A deterministic preparation failure keeps its original code in the
      // terminal detail; the raw Error message alone drops it.
      await this.engineFailureRecovery.recoverFromOuterExecutionFailure(
        task,
        preparationFailure?.detail ?? error,
      );
      task.completedAt = new Date();
      await this._finalize(task);
      if (preparationFailure !== undefined) {
        await this.settlePreparationFailure(task, activation, preparationFailure);
      }
    } finally {
      if (activation && task.executionActivation === activation) {
        task.executionActivation = undefined;
      }
      if (activation && !restsOnPriorTerminal) {
        await activation.reject(
          error,
          preparationFailure === undefined
            ? undefined
            : { skipFailureCompensation: true },
        );
      }
    }
  }

  /**
   * A thrown input preparation failure unwinds through `_consumeEventStream`'s
   * finally, where the still-running task is stamped with the placeholder
   * reason "unknown". `recordTerminationHint` then refuses to record the real
   * aborted reason. Clearing the placeholder lets the recovery below stamp it.
   */
  private clearPrematureUnknownTermination(task: Task): void {
    if (task.terminationReason !== "unknown" || task.terminationEventRecorded === true) {
      return;
    }
    task.terminationReason = undefined;
    task.terminationDetail = undefined;
  }

  /**
   * Closes the deliveries whose turn input never reached the SDK.
   *
   * They were never consumed, so they become uncertain/dead_letter rather than
   * consumed, and they leave the queue so no later drain replays them. Other
   * queued input is preserved; the next explicit start reopens the drain.
   */
  private async settlePreparationFailure(
    task: Task,
    activation: ExecutionActivation | undefined,
    failure: ExecutionPreparationFailure,
  ): Promise<void> {
    task.queuedTerminalResumeBlocked = true;
    const owned = failure.interventions;
    if (owned !== undefined && owned.length > 0) {
      if (activation) activation.admissionMessage = undefined;
      for (const message of owned) {
        removeInterventionMessage(task, message);
        await this.deliveryConsumption?.recordAdmissionFailure(task, message, failure.detail);
      }
      return;
    }
    const message = activation?.admissionMessage;
    if (!activation || !message) return;
    activation.admissionMessage = undefined;
    removeInterventionMessage(task, message);
    await this.deliveryConsumption?.recordAdmissionFailure(task, message, failure.detail);
  }

  private async driveQueuedAfterTerminal(task: Task): Promise<void> {
    const interventionBarrier = task.interruptRequest;
    if (interventionBarrier) {
      try {
        await interventionBarrier;
      } catch (error) {
        this.logger.warn(
          { err: error, sessionId: task.agentSessionId },
          "running intervention barrier failed after execution terminal",
        );
      }
    }
    if (
      task.executionPromise
      || task.queuedTerminalResumeBlocked === true
      || !isTerminalTaskStatus(task.status)
      || task.interventionQueue.length === 0
    ) return;
    try {
      await this.queuedTerminalResume?.(task);
    } catch (error) {
      this.logger.warn(
        { err: error, sessionId: task.agentSessionId },
        "queued terminal delivery auto-resume failed",
      );
    }
  }

  private async startRecordedExecution(
    task: Task,
    agent: AgentProfile,
    backend: BackendId,
    retainedRunner: TaskRunnerRuntime | undefined,
    resolveActivation: () => void,
  ): Promise<void> {
    task.executionRegistration = undefined;
    let runner: TaskRunnerRuntime | undefined;
    let proof: import("./execution_registration.js").RunnerExecutionIdentity | undefined;
    try {
      runner = await this.takeOrCreateRunner(task, agent, backend, retainedRunner);
      if (task.runner) {
        throw new Error(
          `Task ${task.agentSessionId} already has a runner — concurrent execute not supported`,
        );
      }
      this.attachRunner(task, runner);
      proof = await runner.dispatcher.prepareExecutionIdentity?.();
      if (!proof || !isCompleteRunnerExecutionIdentity(proof)) {
        throw new Error(`Runner identity proof unavailable: ${task.agentSessionId}`);
      }
      const application = await this.persistence.recordExecutionRegistrationAndWaitForApplication(
        task.agentSessionId,
        {
          registrationId: proof.registrationId,
          executionCommandId: proof.executionCommandId,
          reviewState: task.reviewState ?? "not_required",
          ...(task.pendingExecutionExpectedTerminalEventId === undefined
            ? {}
            : {
                expectedTerminalEventId:
                  task.pendingExecutionExpectedTerminalEventId,
              }),
        },
      );
      applyCanonicalSessionProjection(task, application.canonicalSession);
      const canonical = application.canonicalExecutionRegistration;
      if (!application.applied || !canonical
        || canonical.registrationId !== proof.registrationId
        || canonical.executionCommandId !== proof.executionCommandId) {
        throw new Error(`Execution registration rejected: ${task.agentSessionId}`);
      }
      task.executionRegistration = {
        registrationId: proof.registrationId,
        executionCommandId: proof.executionCommandId,
      };
      task.runnerTerminalFact = undefined;
      task.pendingExecutionExpectedTerminalEventId = undefined;
      resolveActivation();
      await runner.dispatcher.prepareSession(task.agentSessionId);
      await this._consumeEventStream(task, runner, agent);
    } catch (error) {
      if (runner && task.executionRegistration === undefined) {
        try {
          if (proof && runner.dispatcher.rollbackExecutionIdentity) {
            await runner.dispatcher.rollbackExecutionIdentity(proof);
          } else {
            await runner.dispatcher.close();
          }
        } finally {
          releaseTaskRunner(task, runner);
        }
      }
      throw error;
    }
  }

  private supportsExecutionRegistration(): boolean {
    return typeof this.persistence.recordExecutionRegistrationAndWaitForApplication === "function";
  }

  async releaseRetainedClaudeRunner(task: Task): Promise<void> {
    await this.executorFinalizer.releaseRetainedClaudeRunner(task);
  }

  async releaseExpiredRetainedRunner(
    task: Task,
    registration: RunnerRegistration,
    recordedTerminal: boolean,
  ): Promise<import("./task_executor_finalizer.js").RetainedRunnerReleaseResult> {
    const registrationId = registration.registrationId;
    if (!registrationId) return "not_released";
    return await this.executorFinalizer.releaseExpiredRetainedRunner(
      task,
      registrationId,
      recordedTerminal,
    );
  }

  completeRetainedRunnerReleaseAfterTermination(
    task: Task,
    registration: RunnerRegistration,
  ): boolean {
    const registrationId = registration.registrationId;
    return typeof registrationId === "string"
      && this.executorFinalizer.completeRetainedRunnerReleaseAfterTermination(
        task,
        registrationId,
      );
  }

  /**
   * Reattaches the host to a terminal runner only long enough to ask the SDK
   * whether that process still owns detached background work. No execution
   * admission or foreground frame replay is created here.
   */
  async retainRegisteredDetachedRunner(
    task: Task,
    registration: RunnerRegistration,
  ): Promise<boolean> {
    assertGenericTaskExecution(task, registration.config?.agent?.id);
    // Recovery may retain only an already-terminal task with no current execution registration.
    // Finalization retention runs after the central ACK and has a separate lifecycle.
    if (!isTerminalTaskStatus(task.status) || task.executionRegistration !== undefined) {
      return false;
    }
    if (task.executionPromise !== undefined) return false;
    if (task.runnerReleaseClaim !== undefined) return false;
    const attached = task.runner;
    if (attached) {
      if (attached.dispatcher.registrationId() !== registration.registrationId) {
        return false;
      }
      return await this.executorFinalizer.retainRunnerIfDetachedWorkActive(
        task,
        attached,
      ) === "retained";
    }
    const runner = this.runnerProcessFactory?.recover?.(
      task,
      registration,
      this.snapshotPersistenceFor(task),
      "adopt",
    );
    if (!runner) throw new Error("runner process recovery factory unavailable");
    this.attachRunner(task, runner);
    const retention = await this.executorFinalizer.retainRunnerIfDetachedWorkActive(
      task,
      runner,
    );
    if (retention === "retained") {
      return true;
    }
    if (retention === "codex_inactive") return false;
    if (releaseTaskRunner(task, runner)) await runner.dispatcher.detachHost();
    return false;
  }

  startExecutionWithRunner(
    task: Task,
    agent: AgentProfile,
    runner: TaskRunnerRuntime,
    activation?: ExecutionActivation,
    executionSlotHeld = false,
  ): Promise<void> {
    assertGenericTaskExecution(task, agent.id);
    if (task.runner) {
      throw new Error(
        `Task ${task.agentSessionId} already has a runner — concurrent execute not supported`,
      );
    }
    this.attachRunner(task, runner);
    if (activation) {
      task.executionActivation = activation;
      void activation.promise.catch(() => undefined);
    }

    const promise = (async () => {
      await runner.dispatcher.prepareSession(task.agentSessionId);
      if (activation) {
        task.status = "running";
        if (task.executionActivation === activation) {
          task.executionActivation = undefined;
        }
        activation.resolve();
      }
      await this._consumeEventStream(task, runner, agent);
    })().catch(
      async (err: unknown) => {
        const compensatesRunningTransition =
          activation?.hasFailureCompensation?.() === true;
        try {
          if (compensatesRunningTransition) {
            await activation?.reject(err);
            if (isTerminalTaskStatus(task.status)) return;
          }
          // _consumeEventStream 내부 try/catch가 못 잡는 외부 throw용 안전망.
          const preparationFailure = executionPreparationFailure(err);
          if (preparationFailure?.interventions !== undefined) {
            this.clearPrematureUnknownTermination(task);
          }
          await this.engineFailureRecovery.recoverFromOuterExecutionFailure(
            task,
            preparationFailure?.detail ?? err,
          );
          task.completedAt = new Date();
          await this._finalize(task);
          if (preparationFailure !== undefined) {
            await this.settlePreparationFailure(task, activation, preparationFailure);
          }
        } finally {
          if (activation) {
            if (task.executionActivation === activation) {
              task.executionActivation = undefined;
            }
            if (!compensatesRunningTransition) {
              await activation.reject(err);
            }
          }
        }
      },
    );
    return executionSlotHeld ? promise : this.holdExecutionSlot(task, promise);
  }

  /** Reattaches host-side consumption to an execution already owned by a runner child. */
  async recoverRunnerExecution(
    task: Task,
    agent: AgentProfile,
    runner: TaskRunnerRuntime,
    commandId?: string,
    mode: "adopt" | "replay" | "offline" = "adopt",
    manifestId?: string,
    runtimeEnvIdentity?: string,
  ): Promise<void> {
    return await this.recoverRunnerExecutionLocked(
      task,
      agent,
      runner,
      commandId,
      mode,
      manifestId,
      runtimeEnvIdentity,
    );
  }

  private recoverRunnerExecutionLocked(
    task: Task,
    agent: AgentProfile,
    runner: TaskRunnerRuntime,
    commandId?: string,
    mode: "adopt" | "replay" | "offline" = "adopt",
    manifestId?: string,
    runtimeEnvIdentity?: string,
    onPendingFramesReplayed?: () => void,
    terminalObservation?: RecoveredRunnerTerminalObservation,
    onAdoptionApplication?: (application?: RunnerAdoptionApplication) => void,
  ): Promise<void> {
    assertGenericTaskExecution(task, agent.id);
    if (task.runner) {
      throw new Error(`Task ${task.agentSessionId} already has a runner`);
    }
    const frames = runner.dispatcher.recoverFrames?.(
      commandId,
      onPendingFramesReplayed,
    );
    if (!frames) throw new Error("runner dispatcher does not support execution recovery");
    this.attachRunner(task, runner, mode === "offline");
    if (mode === "offline") task.status = "running";
    const promise = (async () => {
      // Adoption must establish the same durable running projection as a new
      // turn before replaying runner frames. Every new adoption judgment gets
      // its own attempt UUID so a stored rejection is not replayed; an outbox
      // resend of the same event keeps its dedupe key.
      if (mode === "adopt") {
        const registrationId = runner.dispatcher.registrationId();
        let application: Awaited<ReturnType<
          EventPersistence["enqueueRunningTransitionAndWaitForApplication"]
        >>;
        try {
          application = await this.persistence
            .enqueueRunningTransitionAndWaitForApplication(
              task.agentSessionId,
              {
                reviewState: task.reviewState ?? "not_required",
                transitionId: `adopt:${commandId ?? task.lastEventId}:${randomUUID()}`,
                ...(registrationId ? { registrationId } : {}),
              },
            );
        } catch (error) {
          onAdoptionApplication?.();
          throw error;
        }
        onAdoptionApplication?.(application);
        if (!application.applied) {
          const rejection = new RunnerAdoptionRejectedError(
            task.agentSessionId,
            application.rejectionReason,
          );
          if (
            classifyRunnerAdoptRejection(application.rejectionReason)
            === "retryable_rejection"
          ) {
            // 다시 될 수 있는 거절은 러너를 붙인 채 둔다. 프레임 통로도 함께
            // 붙잡아 둔다 — 여기서 놓으면 아이가 확인을 기다리다 멈춘 채로
            // 남고, 나중에 잇기가 적용돼도 그 턴의 출력이 오지 않는다.
            this.suspendedRecoveredExecutions.set(task, {
              agent,
              runner,
              frames,
              terminalObservation,
            });
          }
          throw rejection;
        }
        applyCanonicalSessionProjection(task, application.canonicalSession);
      }
      await this.consumeRecoveredRunnerFrames(
        task,
        agent,
        runner,
        frames,
        mode === "adopt",
        terminalObservation,
      );
    })();
    this.holdExecutionSlot(task, promise);
    return promise;
  }

  recoverRegisteredRunner(
    task: Task,
    registration: RunnerRegistration,
    commandId: string | undefined,
    mode: "adopt" | "replay" | "offline",
    onAttemptCreated?: (runner: TaskRunnerRuntime) => (() => void) | undefined,
    phaseObservation?: RunnerPhaseObservation,
    onAdoptionApplication?: (application?: RunnerAdoptionApplication) => void,
  ): Promise<void> {
    // 가드는 기존 호출 규약대로 동기 예외다. 재부착은 턴 판정을 다시 하지 않는다.
    assertGenericTaskExecution(task, registration.config?.agent?.id);
    return this.recoverRegisteredRunnerAfterGuard(
      task,
      registration,
      commandId,
      mode,
      onAttemptCreated,
      phaseObservation,
      onAdoptionApplication,
    );
  }

  private async recoverRegisteredRunnerAfterGuard(
    task: Task,
    registration: RunnerRegistration,
    commandId: string | undefined,
    mode: "adopt" | "replay" | "offline",
    onAttemptCreated?: (runner: TaskRunnerRuntime) => (() => void) | undefined,
    phaseObservation?: RunnerPhaseObservation,
    onAdoptionApplication?: (application?: RunnerAdoptionApplication) => void,
  ): Promise<void> {
    const config = registration.config;
    // 복구용 러너를 만들기 전에 거절한다. 오프라인 복구 dispatcher는 초기화하면서
    // 세션 writer lock을 이 프로세스 소유로 잡는다. 채택되지 않을 러너를 위해
    // 잠금을 잡지 않도록, 러너가 이미 붙어 있으면 여기서 끝낸다 (카드 #1265).
    if (task.runner) {
      throw new Error(`Task ${task.agentSessionId} already has a runner`);
    }
    // 격리는 실행이 시작될 때 정해지고, 진행 중인 실행은 시작할 때의 격리로 끝난다.
    // 판정이 바뀌었으면 다음 실행에서 takeOrCreateRunner가 이 러너를 닫고 새로 만든다.
    const runner = this.runnerProcessFactory?.recover?.(
      task,
      registration,
      this.snapshotPersistenceFor(task),
      mode,
      phaseObservation,
    );
    if (!runner) throw new Error("runner process recovery factory unavailable");
    const onPendingFramesReplayed = onAttemptCreated?.(runner);
    const terminalObservation = mode === "offline"
      ? recoveredRunnerTerminalObservation(registration)
      : undefined;
    // `recoverRunnerExecutionLocked` rejects synchronously when the task
    // already has a runner, so its refusal has to be caught around the call.
    // Attaching `.catch` alone left the recovery dispatcher -- and, for offline
    // recovery, the session writer lock it took -- owned by this process, and
    // the next spawn terminated the lock owner: soul-server itself (#1265).
    try {
      return await this.recoverRunnerExecutionLocked(
        task,
        config.agent,
        runner,
        commandId,
        mode,
        config.releaseManifestId ?? config.codeSha,
        config.runtimeEnvIdentity ?? `legacy:${config.codeSha}`,
        onPendingFramesReplayed,
        terminalObservation,
        onAdoptionApplication,
      );
    } catch (error) {
      await this.releaseUnadoptedRunner(task, runner, config.sessionId);
      throw error;
    }
  }

  /**
   * Sends only the adoption transition for a runner that is already attached.
   *
   * A rejected adoption keeps the runner attached: the process still holds the
   * turn, and the next central check decides again with a fresh attempt UUID.
   * This path neither re-attaches nor recovers frames.
   */
  async adoptAttachedRunnerExecution(
    task: Task,
    commandId?: string,
  ): Promise<RunnerAdoptionApplication> {
    if (!task.runner) {
      throw new Error(`Task ${task.agentSessionId} has no attached runner to adopt`);
    }
    const registrationId = task.runner.dispatcher.registrationId();
    const application = await this.persistence
      .enqueueRunningTransitionAndWaitForApplication(
        task.agentSessionId,
        {
          reviewState: task.reviewState ?? "not_required",
          transitionId: `adopt:${commandId ?? task.lastEventId}:${randomUUID()}`,
          ...(registrationId ? { registrationId } : {}),
        },
      );
    if (application.applied) {
      applyCanonicalSessionProjection(task, application.canonicalSession);
      this.resumeSuspendedRecoveredExecution(task);
    }
    return {
      applied: application.applied,
      rejectionReason: application.rejectionReason,
    };
  }

  /**
   * 잇기 거절로 멈춰 둔 프레임 소비를 다시 잇는다.
   *
   * 붙인 러너에 보낸 잇기 전이가 적용되면, 시동 복구 때 열어 둔 프레임 통로를
   * 이어서 소비해 턴의 출력과 종료를 평소 경로로 흘려보낸다. 러너가 그 사이
   * 교체됐거나 이미 닫혔으면 아무것도 하지 않는다.
   */
  private resumeSuspendedRecoveredExecution(task: Task): void {
    const suspended = this.suspendedRecoveredExecutions.get(task);
    if (!suspended) return;
    this.suspendedRecoveredExecutions.delete(task);
    if (task.runner !== suspended.runner) return;
    if (suspended.runner.dispatcher.isClosed?.() === true) return;
    if (!suspended.runner.dispatcher.hasActiveExecution()) return;
    if (task.executionPromise) return;
    const promise = this.consumeRecoveredRunnerFrames(
      task,
      suspended.agent,
      suspended.runner,
      suspended.frames,
      true,
      suspended.terminalObservation,
    );
    this.holdExecutionSlot(task, promise);
    void promise.catch((error: unknown) => {
      this.logger.warn(
        { err: error, sessionId: task.agentSessionId },
        "resumed recovered runner execution failed",
      );
    });
  }

  /**
   * Releases a recovery runner handle that never became the task's execution.
   *
   * `recover()` builds a dispatcher before anything has decided the adoption is
   * allowed, and that dispatcher registers the session's durable event stream
   * on the shared mux straight away. When adoption rejects before ownership,
   * no one holds a reference to that dispatcher any more: `task.runner` was
   * never assigned, so no later cleanup can reach it.
   * The stream registration outlives the attempt, the next dispatcher for the
   * same session fails to register at all, and the session goes on to accept a
   * user turn that it can never answer -- one user message, no assistant reply
   * (260822 outage; lab scenario F9).
   *
   * Only what the attempt itself took is given back. The child process keeps
   * running and, critically, keeps its host request channel: a runner mid-tool
   * is waiting on a host request, and aborting that leaves the tool without a
   * result -- the turn then never finishes and its output never reaches the
   * user (lab F9 regression, old turn stuck at tool_start with no tool_result).
   *
   * That includes the offline recovery writer lock. It is owned by this
   * process, and a rejected recovery that kept it made the next spawn for the
   * session terminate the lock owner -- soul-server itself (card #1265).
   */
  private async releaseUnadoptedRunner(
    task: Task,
    runner: TaskRunnerRuntime,
    sessionId: string,
  ): Promise<void> {
    if (task.runner === runner) return;
    try {
      if (runner.dispatcher.releaseUnadoptedRecovery) {
        await runner.dispatcher.releaseUnadoptedRecovery();
      } else {
        await runner.dispatcher.releaseEventStreamRegistration?.();
      }
    } catch (err) {
      this.logger.warn(
        { err, sessionId },
        "unadopted runner host resource release failed; the stream or writer lock may stay held",
      );
    }
  }

  private snapshotPersistenceFor(task: Task): RunnerSnapshotPersistence {
    return {
      persistRunState: async (snapshot, idempotencyKey) =>
        await this.agentsSnapshotPersistence.persistRunStateSnapshot(
          task,
          snapshot,
          idempotencyKey,
        ),
      persistSessionItems: async (snapshot, idempotencyKey) =>
        await this.agentsSnapshotPersistence.persistSessionItemsSnapshot(
          task,
          snapshot,
          idempotencyKey,
        ),
    };
  }

  /**
   * Turn 시퀀스 drain (B-4 multi-turn). 분석 캐시
   * `20260517-1410-codex-ts-folder-resume-intervene.md` §D-3 상태도.
   *
   * codex SDK는 turn-level steer를 지원하지 않으므로 *각 turn = 새 thread.runStreamed()*.
   * 첫 turn은 task.prompt + startThread, 후속 turn은 dequeue된 intervention.text +
   * resumeThread(task.codexThreadId).
   *
   * 게이트:
   *   - generator 정상 종료 + foreground runtime pending → status="error" → loop 종료.
   *   - generator 정상 종료 + status="running" + queue empty → status="completed" → loop 종료.
   *   - generator 정상 종료 + status="running" + queue 비어있지 않음 → dequeue → 다음 turn.
   *   - generator throw + distinct accepted successor owner → 같은 execution에서 다음 대화 진입.
   *   - generator throw + successor owner 증거 없음 → status="error" → loop 종료.
   *   - 외부에서 status="interrupted" 박힘 (cancelTask) → loop 종료.
   *
   * codex_adapter는 같은 인스턴스에서 연속 turn 호출 안전 (concurrent 가드는 turn 종료 시
   * currentTurn=null로 reset, codex_adapter.ts:167-168).
   */
  private async _consumeEventStream(
    task: Task,
    runner: TaskRunnerRuntime,
    agent: AgentProfile,
  ): Promise<void> {
    await persistUnavailablePresetFailure(task, this.persistence);
    if (task.activeGenerationRollover) {
      if (!this.sessionMutations) {
        throw new Error("Session mutation host is required for persistent generation rollover");
      }
      await commitGenerationStart(task, this.persistence, this.sessionMutations);
    }
    const initialTurnInput = await this.turnInputBuilder.prepareInitialTurnInput(task, agent);
    if (initialTurnInput.generationRollover) {
      if (!initialTurnInput.generationCheckpointStats) {
        throw new Error("Generation rollover input is missing checkpoint statistics");
      }
      await publishGenerationStarted(
        task,
        initialTurnInput.generationCheckpointStats,
        this.persistence,
      );
    }
    const endedTurnReceipts: TaskDeliveryTurnReceipt[] = [];
    try {
      await this.consumeTurnLoop(
        task,
        agent,
        runner,
        initialTurnInput,
        endedTurnReceipts,
      );
    } finally {
      if (!isOpenAiAgentsApprovalPending(task)) {
        task.completedAt = new Date();
      }
      await this._finalize(
        task,
        () => this.settleEndedTurnReceipts(task, endedTurnReceipts),
      );
    }
  }

  private async consumeTurnLoop(
    task: Task,
    agent: AgentProfile,
    runner: TaskRunnerRuntime,
    initialTurnInput: TaskTurnInput,
    endedTurnReceipts: TaskDeliveryTurnReceipt[],
  ): Promise<void> {
    let turnInput = initialTurnInput;
    const replayedUnconsumedRuntimeFollowups = new Set<string | InterventionMessage>();
    const pendingExactRuntimeFollowupReplays: InterventionMessage[] = [];
    while (true) {
      if (
        task.pendingClaudeBackendRolloverFrom !== undefined
        && turnInput.backendSessionRolloverFrom === undefined
      ) {
        turnInput = await this.turnInputBuilder.prepareBackendRolloverTurnInput(
          task,
          agent,
          turnInput,
          task.pendingClaudeBackendRolloverFrom,
        );
      }
      const rolloverCycleFromForTurn = turnInput.generationRollover
        ? undefined
        : task.claudeBackendRolloverCycleFrom ?? turnInput.backendSessionRolloverFrom;
      const contextRecovery = createClaudeContextRecoveryObservation();
      let currentTurnInterventions = turnInput.interventions ?? [];
      const compactedBeforeTurn = await this.compactClaudeContextIfNeeded(
        task,
        agent,
        runner,
        turnInput,
      );
      if (compactedBeforeTurn && currentTurnInterventions.length > 0) {
        await task.interruptRequest;
        turnInput = await this.turnInputBuilder.prepareFollowupTurnInput(
          task,
          agent,
          rejoinUnstartedInterventions(task, currentTurnInterventions),
        );
        currentTurnInterventions = turnInput.interventions ?? [];
      }
      const previousAssistantText = normalizeAssistantText(task.lastAssistantText);
      const isCacheKeepaliveTurn = currentTurnInterventions.some(isCacheKeepaliveInput);
      const turnReceipt = this.beginDeliveryTurn(task, currentTurnInterventions);
      let turnCompletedEvent: SSEEventPayload | undefined;
      try {
        try {
          for await (const event of this.engineTurnRunner.executeTurn({
          task,
          agent,
          runner,
          input: {
            prompt: turnInput.prompt,
            ...(turnInput.inputMaterialParts !== undefined
              ? { inputMaterialParts: turnInput.inputMaterialParts }
              : {}),
            ...(turnInput.inputUuid !== undefined
              ? { inputUuid: turnInput.inputUuid }
              : {}),
            ...(turnInput.runnerInterventionId !== undefined
              ? { runnerInterventionId: turnInput.runnerInterventionId }
              : {}),
            ...(turnInput.runnerInterventionIds !== undefined
              ? { runnerInterventionIds: turnInput.runnerInterventionIds }
              : {}),
            ...(turnInput.turnOrigin !== undefined
              ? { turnOrigin: turnInput.turnOrigin }
              : {}),
            imageAttachmentPaths: turnInput.imageAttachmentPaths,
            ...(turnInput.systemPrompt !== undefined
              ? { systemPrompt: turnInput.systemPrompt }
              : {}),
            ...(turnInput.backendSessionRolloverFrom !== undefined
              ? { backendSessionRolloverFrom: turnInput.backendSessionRolloverFrom }
              : {}),
          },
          })) {
            if (event.type === "complete") turnCompletedEvent = event;
            observeClaudeContextRecoveryEvent(contextRecovery, event);
            await this.observeDeliveryTurn(task, turnReceipt, event);
            await this.engineEventPublisher.publishEngineEvent(task, event, {
              alreadyPersisted: runner.eventPersistence === "runner",
              isCacheKeepaliveTurn,
            });
            this.collectClaudeRuntimeTaskFollowup(task, event);
          }
        } catch (err) {
          await task.interruptRequest;
          const disposition = await this.engineFailureRecovery.recoverFromExecuteFailure(
            task,
            err,
            currentTurnInterventions,
          );
          if (disposition === "continue_with_accepted_successor") {
            const transition = resolveTurnLoopTransition(task, agent);
            if (transition.kind === "continue") {
              turnInput = await this.turnInputBuilder.prepareFollowupTurnInput(
                task,
                agent,
                transition.interventions,
              );
              continue;
            }
          }
          if (turnInput.generationRollover) {
            await completeGenerationRollover(task, this.persistence);
          }
          break;
        }
        const lastAcknowledgedEventId = runner.eventPersistence === "runner"
        ? await runner.dispatcher.waitForSessionAck()
        : await this.persistence.waitForSessionAck(task.agentSessionId);
      if (lastAcknowledgedEventId !== null) {
        task.lastEventId = lastAcknowledgedEventId;
      }
      await this.setClaudeContextUsage(
        task,
        contextRecovery.compactCompleted
          ? undefined
          : contextRecovery.latestContextUsage
            ? { ...contextRecovery.latestContextUsage, observedAtMs: Date.now() }
            : task.claudeContextUsage,
      );
      if (contextRecovery.promptTooLongMessage !== undefined) {
        const previousSessionId = task.pendingClaudeBackendRolloverFrom
          ?? task.codexThreadId;
        const attempts = task.claudeBackendRolloverAttempts ?? 0;
        const canRollover =
          effectiveTaskBackend(task, agent) === "claude"
          && previousSessionId !== undefined
          && attempts < CLAUDE_BACKEND_ROLLOVER_LIMIT
          && !contextRecovery.replayUnsafeEventObserved;
        if (canRollover) {
          const nextAttempts = attempts + 1;
          const metadataEntry = claudeBackendRolloverMetadataEntry({
            attempts: nextAttempts,
            phase: "pending",
            previousSessionId,
          });
          const metadataEventId = await this.persistence.enqueueMetadataEffect(
            task.agentSessionId,
            metadataEntry,
            {
              replaceExistingType: "claude_backend_rollover",
              waitForAck: true,
              semanticDedupeKey:
                `claude-backend-rollover:${task.agentSessionId}:${previousSessionId}:${nextAttempts}`,
              ...(task.executionRegistration
                ? { registrationId: task.executionRegistration.registrationId }
                : {}),
            },
          );
          if (metadataEventId !== null) task.lastEventId = metadataEventId;
          task.metadata = [
            ...(task.metadata ?? []).filter((entry) =>
              entry.type !== "claude_backend_rollover",
            ),
            metadataEntry,
          ];
          task.claudeBackendRolloverAttempts = nextAttempts;
          task.claudeBackendRolloverCycleFrom = previousSessionId;
          task.pendingClaudeBackendRolloverFrom = previousSessionId;
          await this.setClaudeContextUsage(task, undefined);
          turnInput = await this.turnInputBuilder.prepareBackendRolloverTurnInput(
            task,
            agent,
            turnInput,
            previousSessionId,
          );
          continue;
        }
        await this.engineEventPublisher.publishEngineEvent(
          task,
          fatalPromptTooLongEvent(contextRecovery.promptTooLongMessage),
        );
        const fatalEventId = await this.persistence.waitForSessionAck(task.agentSessionId);
        if (fatalEventId !== null) task.lastEventId = fatalEventId;
        this.engineFailureRecovery.recoverFromSynthesizedFailure(
          task,
          contextRecovery.promptTooLongMessage,
        );
        break;
      }
      if (
        rolloverCycleFromForTurn !== undefined
        && task.status === "running"
        && task.pendingClaudeBackendRolloverFrom === undefined
        && task.codexThreadId !== undefined
        && task.codexThreadId !== rolloverCycleFromForTurn
      ) {
        await this.completeClaudeBackendRolloverCycle(
          task,
          rolloverCycleFromForTurn,
          task.codexThreadId,
        );
      }
      if (turnInput.generationRollover) {
        await completeGenerationRollover(task, this.persistence);
      }
      if (turnCompletedEvent) {
        await this.decidePersistentTurnEnd(task, turnCompletedEvent, currentTurnInterventions);
      }
      if (
        contextRecovery.preemptiveCompactNeeded
        && !contextRecovery.compactCompleted
      ) {
        await this.compactClaudeContextIfNeeded(task, agent, runner);
      }
      await this.flushClaudeRuntimeTaskFollowups(task);
      let runtimeFollowupReceiptMissing = false;
      for (const intervention of currentTurnInterventions) {
        runtimeFollowupReceiptMissing = this.handleClaudeRuntimeFollowupReceipt(
          task,
          intervention,
          previousAssistantText,
          turnReceipt,
          replayedUnconsumedRuntimeFollowups,
          pendingExactRuntimeFollowupReplays,
        ) || runtimeFollowupReceiptMissing;
      }
      if (runtimeFollowupReceiptMissing) {
        for (const intervention of currentTurnInterventions) {
          if (intervention.source !== CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE) {
            enqueueInterventionOnce(task, intervention);
          }
        }
      }
      await task.interruptRequest;
      if (
        task.status === "running"
        && pendingExactRuntimeFollowupReplays.length > 0
      ) {
        const highPriorityInterventions = dequeueInterventionsInLane(task, "high");
        if (highPriorityInterventions.length > 0) {
          await turnReceipt?.consume(task);
          turnInput = await this.turnInputBuilder.prepareFollowupTurnInput(
            task,
            agent,
            highPriorityInterventions,
          );
          continue;
        }
      }
      const exactRuntimeFollowupReplay = pendingExactRuntimeFollowupReplays.shift();
      if (exactRuntimeFollowupReplay && task.status === "running") {
        await turnReceipt?.consume(task);
        turnInput = await this.turnInputBuilder.prepareFollowupTurnInput(
          task,
          agent,
          [exactRuntimeFollowupReplay],
        );
        continue;
      }
      const transition = resolveTurnLoopTransition(task, agent);
      if (transition.kind === "awaiting_runtime") {
        await this.publishPendingClaudeRuntimeAfterTurnError(task);
      }
      await this.settleDeliveryTurn(
        task,
        turnReceipt,
        transition,
        endedTurnReceipts,
      );
      if (transition.kind !== "continue") break;
        turnInput = await this.turnInputBuilder.prepareFollowupTurnInput(
          task,
          agent,
          transition.interventions,
        );
      } finally {
        if (turnReceipt) endedTurnReceipts.push(turnReceipt);
        this.releaseDeliveryTurn(task, turnReceipt);
      }
    }
  }

  private beginDeliveryTurn(
    task: Task,
    interventions: readonly InterventionMessage[],
  ): TaskDeliveryTurnReceipt | undefined {
    if (!this.deliveryConsumption) return undefined;
    const receipt = new TaskDeliveryTurnReceipt(
      this.deliveryConsumption,
      interventions,
      (proof: ClaudeBackgroundConsumptionProof) =>
        this.claudeRuntimeTaskFollowup?.retireConsumedProof?.(task, proof),
    );
    task.activeDeliveryTurnReceipt = receipt;
    return receipt;
  }

  private async observeDeliveryTurn(
    task: Task,
    receipt: TaskDeliveryTurnReceipt | undefined,
    event: SSEEventPayload,
  ): Promise<void> {
    await receipt?.observe(task, event);
  }

  private async settleDeliveryTurn(
    task: Task,
    receipt: TaskDeliveryTurnReceipt | undefined,
    transition: TurnLoopTransitionDecision,
    terminalTurnReceipts: TaskDeliveryTurnReceipt[],
  ): Promise<void> {
    if (!receipt) return;
    if (transition.kind === "continue") {
      await receipt.consume(task);
    } else if (task.status === "completed") {
      terminalTurnReceipts.push(receipt);
    }
  }

  private releaseDeliveryTurn(
    task: Task,
    receipt: TaskDeliveryTurnReceipt | undefined,
  ): void {
    if (task.activeDeliveryTurnReceipt === receipt) {
      delete task.activeDeliveryTurnReceipt;
    }
  }

  private async completeClaudeBackendRolloverCycle(
    task: Task,
    previousSessionId: string,
    backendSessionId: string,
  ): Promise<void> {
    const metadataEntry = claudeBackendRolloverMetadataEntry({
      attempts: 0,
      phase: "completed",
      previousSessionId,
      backendSessionId,
    });
    const metadataEventId = await this.persistence.enqueueMetadataEffect(
      task.agentSessionId,
      metadataEntry,
      {
        replaceExistingType: "claude_backend_rollover",
        waitForAck: true,
        semanticDedupeKey:
          `claude-backend-rollover:${task.agentSessionId}:${previousSessionId}:${backendSessionId}:completed`,
        ...(task.executionRegistration
          ? { registrationId: task.executionRegistration.registrationId }
          : {}),
      },
    );
    if (metadataEventId !== null) task.lastEventId = metadataEventId;
    task.metadata = [
      ...(task.metadata ?? []).filter((entry) =>
        entry.type !== "claude_backend_rollover",
      ),
      metadataEntry,
    ];
    task.claudeBackendRolloverAttempts = 0;
    task.claudeBackendRolloverCycleFrom = undefined;
    task.pendingClaudeBackendRolloverFrom = undefined;
  }

  /**
   * Single writer for `task.claudeContextUsage`.
   *
   * Persists the observation so a restarted process can restore it before the
   * next pre-turn compaction check (see `hydrateTaskFromEvictedRow`). Equal
   * values return immediately without enqueueing: turns that never observe
   * context usage must not grow the metadata stream.
   */
  private async setClaudeContextUsage(
    task: Task,
    next: ObservedClaudeContextUsage | undefined,
  ): Promise<void> {
    const previous = task.claudeContextUsage;
    if (
      previous?.usedTokens === next?.usedTokens
      && previous?.maxTokens === next?.maxTokens
      && previous?.observedAtMs === next?.observedAtMs
    ) {
      return;
    }
    task.claudeContextUsage = next;
    const metadataEntry = buildClaudeContextUsageMetadataEntry(next ?? null);
    task.metadata = [
      ...(task.metadata ?? []).filter((entry) => entry.type !== "claude_context_usage"),
      metadataEntry,
    ];
    try {
      await this.persistence.enqueueMetadataEffect(
        task.agentSessionId,
        metadataEntry,
        {
          replaceExistingType: "claude_context_usage",
          ...(task.executionRegistration
            ? { registrationId: task.executionRegistration.registrationId }
            : {}),
        },
      );
    } catch (err) {
      this.logger.warn(
        { err, sessionId: task.agentSessionId },
        "claude context usage metadata persistence failed",
      );
    }
  }

  private async compactClaudeContextIfNeeded(
    task: Task,
    agent: AgentProfile,
    runner: TaskRunnerRuntime,
    incoming?: TaskTurnInput,
  ): Promise<boolean> {
    const incomingTokens = incoming ? estimateClaudeTurnInputTokens(incoming) : 0;
    if (!shouldPreemptivelyCompact(task.claudeContextUsage, incomingTokens)) return false;
    if (
      effectiveTaskBackend(task, agent) !== "claude"
      || !task.codexThreadId
      || typeof (runner.engine as EnginePort & Partial<SupportsCompact>).compact !== "function"
    ) {
      return false;
    }
    const compactParams = incoming === undefined
      ? undefined
      : this.engineTurnRunner.buildCompactExecuteParams(task, agent, incoming);
    try {
      const compactedContextUsage = compactParams === undefined
        ? await (runner.engine as EnginePort & SupportsCompact).compact(task.codexThreadId)
        : await (runner.engine as EnginePort & SupportsCompact)
          .compact(task.codexThreadId, compactParams);
      await this.engineEventPublisher.publishEngineEvent(task, {
        type: "compact",
        trigger: "auto_preemptive",
        message: "Claude session compacted (auto_preemptive)",
      } as SSEEventPayload);
      if (compactedContextUsage) {
        const contextUsage = makeContextUsagePayload(
          compactedContextUsage.usedTokens,
          compactedContextUsage.maxTokens,
          { estimated: compactedContextUsage.estimated },
        );
        if (contextUsage) {
          await this.engineEventPublisher.publishEngineEvent(task, contextUsage);
        }
      }
      const compactEventId = await this.persistence.waitForSessionAck(task.agentSessionId);
      if (compactEventId !== null) task.lastEventId = compactEventId;
      return true;
    } catch (error) {
      this.logger.warn(
        { err: error, sessionId: task.agentSessionId },
        "Claude preemptive compact failed; prompt-too-long rollover remains available",
      );
      return false;
    } finally {
      await this.setClaudeContextUsage(task, undefined);
    }
  }

  private async consumeRecoveredRunnerFrames(
    task: Task,
    agent: AgentProfile,
    runner: TaskRunnerRuntime,
    frames: AsyncIterable<import("../runner/frame_protocol.js").RunnerEventFrame>,
    propagateFailure: boolean,
    terminalObservation?: RecoveredRunnerTerminalObservation,
  ): Promise<void> {
    const contextRecovery = createClaudeContextRecoveryObservation();
    const terminalTurnReceipts: TaskDeliveryTurnReceipt[] = [];
    const turnReceipt = this.beginDeliveryTurn(task, []);
    let recoveryFailed = false;
    let recoveryFailure: unknown;
    let recoveryPreparationFailure: ExecutionPreparationFailure | undefined;
    try {
      for await (const event of this.engineTurnRunner.recoverTurn(task, runner, frames)) {
        observeClaudeContextRecoveryEvent(contextRecovery, event);
        await this.observeDeliveryTurn(task, turnReceipt, event);
        await this.engineEventPublisher.publishEngineEvent(task, event, {
          alreadyPersisted: true,
        });
        this.collectClaudeRuntimeTaskFollowup(task, event);
      }
      await this.setClaudeContextUsage(
        task,
        contextRecovery.compactCompleted
          ? undefined
          : contextRecovery.latestContextUsage
            ? { ...contextRecovery.latestContextUsage, observedAtMs: Date.now() }
            : task.claudeContextUsage,
      );
      if (
        terminalObservation === undefined
        && contextRecovery.preemptiveCompactNeeded
        && !contextRecovery.compactCompleted
      ) {
        await this.compactClaudeContextIfNeeded(task, agent, runner);
      }
      if (
        contextRecovery.promptTooLongMessage !== undefined
        && task.claudeBackendRolloverCycleFrom !== undefined
      ) {
        await this.engineEventPublisher.publishEngineEvent(
          task,
          fatalPromptTooLongEvent(contextRecovery.promptTooLongMessage),
        );
        const fatalEventId = await this.persistence.waitForSessionAck(task.agentSessionId);
        if (fatalEventId !== null) task.lastEventId = fatalEventId;
        this.engineFailureRecovery.recoverFromSynthesizedFailure(
          task,
          contextRecovery.promptTooLongMessage,
        );
        return;
      }
      if (
        task.claudeBackendRolloverCycleFrom !== undefined
        && task.status === "running"
        && task.pendingClaudeBackendRolloverFrom === undefined
        && task.codexThreadId !== undefined
        && task.codexThreadId !== task.claudeBackendRolloverCycleFrom
      ) {
        await this.completeClaudeBackendRolloverCycle(
          task,
          task.claudeBackendRolloverCycleFrom,
          task.codexThreadId,
        );
      }
      await this.flushClaudeRuntimeTaskFollowups(task);
      await task.interruptRequest;
      if (terminalObservation) {
        this.lifecycleTransition.applyRunnerTerminalFact(
          task,
          terminalObservation.fact,
          terminalObservation.detail,
        );
      }
      const transition = resolveTurnLoopTransition(task, agent);
      if (transition.kind === "awaiting_runtime") {
        await this.publishPendingClaudeRuntimeAfterTurnError(task);
      } else if (transition.kind === "continue") {
        await this.settleDeliveryTurn(
          task,
          turnReceipt,
          transition,
          terminalTurnReceipts,
        );
        this.releaseDeliveryTurn(task, turnReceipt);
        const followupTurnInput = await this.turnInputBuilder.prepareFollowupTurnInput(
          task,
          agent,
          transition.interventions,
        );
        await this.consumeTurnLoop(
          task,
          agent,
          runner,
          followupTurnInput,
          terminalTurnReceipts,
        );
      } else {
        await this.settleDeliveryTurn(
          task,
          turnReceipt,
          transition,
          terminalTurnReceipts,
        );
      }
    } catch (error) {
      const preparationFailure = executionPreparationFailure(error);
      if (preparationFailure?.interventions !== undefined) {
        // A typed input preparation failure owns its batch. The ordinary
        // engine-failure route may yield to a queued successor and leave this
        // attempt running with no terminal, so it must end as an error here.
        this.clearPrematureUnknownTermination(task);
        await this.engineFailureRecovery.recoverFromOuterExecutionFailure(
          task,
          preparationFailure.detail,
        );
      } else {
        await this.engineFailureRecovery.recoverFromExecuteFailure(task, error);
      }
      recoveryFailed = true;
      recoveryFailure = error;
      recoveryPreparationFailure = preparationFailure;
    } finally {
      this.releaseDeliveryTurn(task, turnReceipt);
      try {
        const lastAcknowledgedEventId = await runner.dispatcher.waitForSessionAck();
        if (lastAcknowledgedEventId !== null) task.lastEventId = lastAcknowledgedEventId;
      } catch (error) {
        this.logger.warn(
          { err: error, sessionId: task.agentSessionId },
          "runner recovery ACK drain failed",
        );
      }
      task.completedAt = new Date();
      await this._finalize(
        task,
        () => this.settleEndedTurnReceipts(task, terminalTurnReceipts),
      );
      if (recoveryPreparationFailure !== undefined) {
        await this.settlePreparationFailure(task, undefined, recoveryPreparationFailure);
      }
    }
    // Startup adoption owns a live child. Its caller must be able to re-check
    // that ownership and replace a dead/unreachable registration. Offline
    // terminal replay intentionally keeps the historical swallow-and-finalize
    // contract because the durable terminal error is the replay result.
    if (recoveryFailed && propagateFailure) throw recoveryFailure;
  }

  private async publishPendingClaudeRuntimeAfterTurnError(task: Task): Promise<void> {
    const failedTasks = failBlockingClaudeRuntimeWork(
      task,
      CLAUDE_RUNTIME_PENDING_AFTER_TURN_MESSAGE,
    );
    const message = `${CLAUDE_RUNTIME_PENDING_AFTER_TURN_MESSAGE} Pending task(s): ${failedTasks
      .map((runtimeTask) => runtimeTask.taskId)
      .join(", ") || "unknown"}.`;
    await this.engineEventPublisher.publishEngineEvent(task, {
      type: "error",
      message,
      error_code: "claude_runtime_pending_after_turn",
      fatal: true,
      recoverable: true,
      recovery_hint: "Send another message to resume this session in a fresh turn.",
    } as SSEEventPayload);
    this.engineFailureRecovery.recoverFromSynthesizedFailure(task, message);
  }

  private collectClaudeRuntimeTaskFollowup(task: Task, event: SSEEventPayload): void {
    if (!this.claudeRuntimeTaskFollowup) return;
    try {
      this.claudeRuntimeTaskFollowup.collect(task, event);
    } catch (err) {
      this.logger.warn(
        { err, sessionId: task.agentSessionId },
        "Claude runtime task follow-up collection failed",
      );
    }
  }

  private async flushClaudeRuntimeTaskFollowups(task: Task): Promise<void> {
    if (!this.claudeRuntimeTaskFollowup) return;
    try {
      await this.claudeRuntimeTaskFollowup.flush(task);
    } catch (err) {
      this.logger.warn(
        { err, sessionId: task.agentSessionId },
        "Claude runtime task follow-up flush failed",
      );
      await this.publishClaudeRuntimeFollowupEnqueueFailed(task, err);
    }
  }

  private handleClaudeRuntimeFollowupReceipt(
    task: Task,
    intervention: InterventionMessage | undefined,
    previousAssistantText: string,
    receipt: TaskDeliveryTurnReceipt | undefined,
    replayedInExecution: Set<string | InterventionMessage>,
    pendingExactReplays: InterventionMessage[],
  ): boolean {
    if (intervention?.source !== CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE) return false;
    if (!receipt) return false;
    const nextAssistantText = normalizeAssistantText(task.lastAssistantText);
    const reason = resolveFollowupStallReason(previousAssistantText, nextAssistantText);
    const consumptionReceiptObserved =
      receipt.hasConsumptionReceipt(intervention);
    if (consumptionReceiptObserved) {
      if (!reason) return false;
      this.logger.info(
        {
          sessionId: task.agentSessionId,
          deliveryId: intervention.deliveryId,
          followupKey: intervention.followupKey,
          reason,
          consumptionReceiptObserved,
        },
        "Claude runtime task follow-up ended without a new response after consumption",
      );
      return false;
    }

    const replayKey = intervention.deliveryId ?? intervention;
    const alreadyReplayed = replayedInExecution.has(replayKey);
    const details = {
      sessionId: task.agentSessionId,
      deliveryId: intervention.deliveryId,
      followupKey: intervention.followupKey,
      reason: reason ?? "missing_consumption_receipt",
      consumptionReceiptObserved,
      alreadyReplayed,
    };
    if (!alreadyReplayed) {
      replayedInExecution.add(replayKey);
      pendingExactReplays.push(intervention);
      this.logger.warn(
        details,
        "Claude runtime task follow-up had no consumption receipt; replaying the same delivery once",
      );
      return true;
    }
    this.logger.warn(
      details,
      "Claude runtime task follow-up still had no consumption receipt after exact replay; original delivery remains replayable",
    );
    return true;
  }

  private async publishClaudeRuntimeFollowupEnqueueFailed(
    task: Task,
    err: unknown,
  ): Promise<void> {
    await this.engineEventPublisher.publishEngineEvent(task, {
      type: "error",
      message:
        `Background task follow-up could not be queued automatically: ${formatErrorMessage(err)}. ` +
        "The pending follow-up was kept for a later retry.",
      error_code: "claude_runtime_followup_enqueue_failed",
      fatal: false,
      recoverable: true,
      recovery_hint:
        "Send another message to resume this session if the automatic follow-up does not appear.",
    } as SSEEventPayload);
  }

  /**
   * 종료 처리: final-state persistence + engine cleanup + delegated completion notification.
   */
  /**
   * Attaching a runner and recording what kind of runner it is are one act.
   *
   * When they were separate, an offline replay could leave the flag set behind
   * it, and the next live turn would inherit it — silently disabling Claude
   * background retention for a runner that really did own live work.
   */
  private attachRunner(
    task: Task,
    runner: TaskRunnerRuntime,
    offlineReplay = false,
  ): void {
    task.runner = runner;
    task.runnerIsOfflineReplay = offlineReplay;
  }

  /**
   * 엔진이 치명 오류로 죽었는데 그 오류를 받을 턴이 없을 때(분리 이벤트) 오류
   * 종료 사건을 올린다. 진행 중인 실행이 있으면 그 실행의 종료 길이 같은 오류를
   * 받아 끝내므로 여기서는 손대지 않는다.
   */
  async terminateAfterFatalEngineError(task: Task, message: string): Promise<boolean> {
    if (!isActiveTaskStatus(task.status)) return false;
    if (
      task.executionPromise !== undefined
      || task.runner?.dispatcher.hasActiveExecution?.() === true
    ) return false;
    this.engineFailureRecovery.recoverFromSynthesizedFailure(task, message);
    task.completedAt = new Date();
    await this._finalize(task);
    return true;
  }

  private async _finalize(
    task: Task,
    settleEndedTurnDeliveries?: () => Promise<void>,
  ): Promise<void> {
    // 일반 세션의 다음 모델 pending은 terminal 저장보다 먼저 내구 기록되어야
    // 재개 뒤 첫 실행이 새 세대로 시작한다. 저장에 실패하면 기존 종료로 둔다.
    const fallbackPrepared = await this.prepareSessionModelFallback(task);
    await this.executorFinalizer.finalize(
      task,
      settleEndedTurnDeliveries,
      fallbackPrepared
        ? async (terminalTransitionApplied: boolean) =>
            await this.finishSessionModelFallback(task, terminalTransitionApplied)
        : undefined,
    );
    await this.decidePersistentLimitHit(task);
  }

  /**
   * 한도로 끝나는 일반 세션이면 다음 모델 pending을 terminal 저장 전에 남긴다.
   * `true`면 finalize의 notify 단계에서 이어가기 예약을 판정한다.
   */
  private async prepareSessionModelFallback(task: Task): Promise<boolean> {
    const runtime = this.sessionModelFallbackRuntime;
    if (!runtime || task.persistent === true) return false;
    if (task.persistentGeneration?.pending?.reason === SESSION_MODEL_FALLBACK_REASON) {
      return true;
    }
    try {
      const target = await runtime.chooseTarget(task);
      if (target === null) return false;
      await runtime.persistentSessions.requestSessionModelFallbackRollover(
        task.agentSessionId,
        target,
      );
      return true;
    } catch (err) {
      this.logger.warn(
        { err, sessionId: task.agentSessionId },
        "session model fallback pending save failed",
      );
      return false;
    }
  }

  /**
   * Terminal 저장과 runner 해제 뒤에 이어가기 재개를 예약한다. 예약에 성공하면
   * 이번 실행의 완료 통지만 건너뛰고, 실패하거나 terminal event id가 없으면
   * pending을 취소하고 기존 완료 통지를 유지한다.
   */
  private async finishSessionModelFallback(
    task: Task,
    terminalTransitionApplied: boolean,
  ): Promise<boolean> {
    const runtime = this.sessionModelFallbackRuntime;
    const pending = task.persistentGeneration?.pending;
    if (!runtime || pending?.reason !== SESSION_MODEL_FALLBACK_REASON) return false;
    const terminalEventId = task.terminalEventId;
    if (!terminalTransitionApplied || terminalEventId === undefined) {
      await this.cancelSessionModelFallback(task);
      return false;
    }
    try {
      const now = new Date();
      await runtime.scheduleService.scheduleResumeAfterLimit(
        task.agentSessionId,
        terminalEventId,
        now,
        now,
        SESSION_MODEL_FALLBACK_RESUME_PROMPT,
      );
      return true;
    } catch (err) {
      this.logger.warn(
        { err, sessionId: task.agentSessionId },
        "session model fallback resume schedule failed",
      );
      await this.cancelSessionModelFallback(task);
      return false;
    }
  }

  private async cancelSessionModelFallback(task: Task): Promise<void> {
    try {
      await this.sessionModelFallbackRuntime?.persistentSessions
        .cancelPendingGenerationRollover(task.agentSessionId);
    } catch (err) {
      this.logger.warn(
        { err, sessionId: task.agentSessionId },
        "session model fallback pending cancel failed",
      );
    }
  }

  private async settleEndedTurnReceipts(
    task: Task,
    receipts: readonly TaskDeliveryTurnReceipt[],
  ): Promise<void> {
    // A completed turn can be collected both by settleDeliveryTurn and by the
    // turn loop's finally; settle each receipt once.
    for (const receipt of new Set(receipts)) await receipt.settleEndedTurn(task);
  }
}

function hasUnappliedOrNonArrivalPendingGeneration(task: Task): boolean {
  const pending = task.persistentGeneration?.pending;
  if (!pending) return false;
  if (pending.applyingFrom === undefined) return true;
  return !pending.reason.startsWith("auto:arrival.");
}

function persistentSelectionForTarget(
  task: Task,
  targetPreset: string,
  fallbackModelsDefault: readonly PersistentModelSelection[],
) {
  const settings = readStoredPersistentSettings(task.metadata, fallbackModelsDefault);
  if (settings?.default_model?.model_preset === targetPreset) return settings.default_model;
  return settings?.fallback_models.find((selection) => selection.model_preset === targetPreset);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const PROFILE_WORKSPACE_UNAVAILABLE = "PROFILE_WORKSPACE_UNAVAILABLE";

class ProfileWorkspaceUnavailableError extends Error {
  readonly code: string = PROFILE_WORKSPACE_UNAVAILABLE;
}

/**
 * A preparation failure that owns the input it could not turn into SDK input.
 *
 * `interventions` is present only for a turn input assembly failure: those
 * messages were dequeued but never reached the SDK, so they must close as
 * uncertain rather than stay queued for a later replay.
 */
interface ExecutionPreparationFailure {
  detail: string;
  interventions?: readonly InterventionMessage[];
}

/** Preparation failures that repeat identically on every retry. */
function executionPreparationFailure(
  error: unknown,
): ExecutionPreparationFailure | undefined {
  const isolationFailure = isolationPreparationFailureDetail(error);
  if (isolationFailure !== undefined) return { detail: isolationFailure };
  if (error instanceof ProfileWorkspaceUnavailableError) {
    return { detail: `${PROFILE_WORKSPACE_UNAVAILABLE}: ${error.message}` };
  }
  if (error instanceof TurnInputPreparationError) {
    return { detail: error.message, interventions: error.interventions };
  }
  return undefined;
}

function keepaliveResultFor(
  completeEvent: SSEEventPayload,
  interventions: readonly InterventionMessage[],
): { input_tokens: number; cached_input_tokens: number; cache_hit: boolean } | undefined {
  if (!interventions.some(isCacheKeepaliveInput)) {
    return undefined;
  }
  const firstCall = (completeEvent as { first_call?: unknown }).first_call;
  if (typeof firstCall !== "object" || firstCall === null || Array.isArray(firstCall)) {
    return undefined;
  }
  const usage = firstCall as Record<string, unknown>;
  if (typeof usage.input_tokens !== "number" || typeof usage.cached_input_tokens !== "number") {
    return undefined;
  }
  return {
    input_tokens: usage.input_tokens,
    cached_input_tokens: usage.cached_input_tokens,
    cache_hit: usage.cached_input_tokens > 0,
  };
}

/** 외부 검증용 — task가 종료 상태인지. */
export function isTerminalStatus(status: TaskStatus): boolean {
  return isTerminalTaskStatus(status);
}

function normalizeAssistantText(text: string | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function resolveFollowupStallReason(
  previousAssistantText: string,
  nextAssistantText: string,
): "empty_response" | "repeated_response" | null {
  if (!nextAssistantText) return "empty_response";
  if (previousAssistantText && nextAssistantText === previousAssistantText) {
    return "repeated_response";
  }
  return null;
}

function formatErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
