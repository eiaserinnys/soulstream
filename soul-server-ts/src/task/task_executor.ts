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

import type { AgentProfile } from "../agent_registry.js";
import type { ModelCatalog } from "../model_catalog.js";
import type {
  BackendId,
  EnginePort,
  ScheduleToolUseHandler,
  SSEEventPayload,
  SupportsCompact,
} from "../engine/protocol.js";
import type { EventPersistence } from "../db/event_persistence.js";
import type { SessionDB } from "../db/session_db.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";
import type { ExecutionContextBuilder } from "../context/context_builder.js";
import {
  createInProcessTaskRunnerRuntime,
  type TaskRunnerRuntime,
} from "../runner/task_runner_runtime.js";
import type { RunnerChildConfig } from "../runner/runner_process_spawn.js";
import type { RunnerRegistration } from "../runner/runner_process_registry.js";
import { RunnerOrphanedSpawnError } from "../runner/runner_process_dispatcher.js";

import type { CompletionNotifier } from "./completion_notifier.js";
import { inspectProcessIdentity } from "../runner/runner_process_lock.js";
import type { ExecutionOwnershipBackoff } from "./execution_ownership_backoff.js";
import { ExecutionOwnershipExpiry } from "./execution_ownership_expiry.js";
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
  isTerminalTaskStatus,
  type InterventionMessage,
  type Task,
  type TaskStatus,
} from "./task_models.js";
import { enqueueInterventionOnce } from "./task_intervention_queue.js";
import {
  isOpenAiAgentsApprovalPending,
  resolveTurnLoopTransition,
} from "./task_turn_loop_transition.js";
import {
  TaskTurnInputBuilder,
  type TaskTurnInput,
} from "./task_turn_input_builder.js";
import { failBlockingClaudeRuntimeWork } from "./claude_runtime_state.js";
import {
  CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
  MAX_CLAUDE_RUNTIME_FOLLOWUP_ATTEMPT,
  type ClaudeRuntimeFollowupStallReason,
  type ClaudeRuntimeTaskFollowupPort,
} from "./claude_runtime_task_followup.js";
import type { TaskDeliveryLedgerGate } from "./task_delivery_ledger_gate.js";
import { TaskDeliveryConsumption } from "./task_delivery_consumption.js";
import { TaskDeliveryTurnReceipt } from "./task_delivery_turn_receipt.js";
import {
  applyModelPresetRuntime,
  effectiveTaskBackend,
} from "./task_model_preset.js";
import {
  ExecutionOwnershipConflictError,
  isCompleteExecutionIdentity,
  isExecutionOwnershipConflictError,
  newExecutionOwnershipGeneration,
  type ExecutionEntryPath,
  type ExecutionOwnerKind,
} from "./execution_ownership.js";
import { ExecutionOwnershipCoordinator } from
  "./execution_ownership_coordinator.js";
import {
  CLAUDE_BACKEND_ROLLOVER_LIMIT,
  claudeBackendRolloverMetadataEntry,
  createClaudeContextRecoveryObservation,
  estimateClaudeTurnInputTokens,
  fatalPromptTooLongEvent,
  observeClaudeContextRecoveryEvent,
  shouldPreemptivelyCompact,
} from "./claude_context_recovery.js";

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
  recover?(
    task: Task,
    registration: RunnerRegistration,
    snapshots: RunnerSnapshotPersistence,
    mode?: "adopt" | "replay" | "offline",
  ): TaskRunnerRuntime;
  restart?(
    task: Task,
    config: RunnerChildConfig,
    snapshots: RunnerSnapshotPersistence,
  ): TaskRunnerRuntime;
  describe?(agent: AgentProfile): Promise<{
    ownerKind: "runner_process";
    manifestId: string;
    runtimeEnvIdentity: string;
  }>;
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
  private readonly executionOwnershipCoordinator: ExecutionOwnershipCoordinator;
  private readonly executionOwnershipExpiry: ExecutionOwnershipExpiry;
  constructor(
    private readonly engineFactory: EngineFactory,
    db: SessionDB,
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
      "recordConsumed" | "recordTurnStarted" | "discardIfConsumed"
    >,
    private readonly modelCatalog?: Pick<ModelCatalog, "resolve">,
    private readonly runnerProcessFactory?: RunnerProcessRuntimeFactory,
    transientEventLogAggregator?: TransientEventLogAggregator,
    private readonly executionOwnershipBackoff?: ExecutionOwnershipBackoff,
    executionOwnershipNodeId?: string,
  ) {
    this.lifecycleTransition = new TaskLifecycleTransition({
      logger: this.logger,
      persistence,
    });
    this.executorFinalizer = new TaskExecutorFinalizer({
      lifecycleTransition: this.lifecycleTransition,
      logger: this.logger,
      completionNotifier,
    });
    this.engineEventPublisher = new TaskEngineEventPublisher({
      broadcaster,
      logger: this.logger,
      persistence,
      ...(transientEventLogAggregator ? { transientEventLogAggregator } : {}),
    });
    this.engineFailureRecovery = new TaskEngineFailureRecovery({
      broadcaster,
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
    });
    this.agentsSnapshotPersistence = new TaskAgentsSnapshotPersistence({
      persistence,
      logger: this.logger,
    });
    this.engineTurnRunner = new TaskEngineTurnRunner({
      snapshotPersistence: this.agentsSnapshotPersistence,
      scheduleToolHandler,
    });
    this.deliveryConsumption = deliveryConsumptionRecorder
      ? new TaskDeliveryConsumption(deliveryConsumptionRecorder, this.logger)
      : undefined;
    this.executionOwnershipCoordinator = new ExecutionOwnershipCoordinator(
      persistence,
      this.logger,
    );
    this.executionOwnershipExpiry = new ExecutionOwnershipExpiry({
      expireDeadOwner: (sessionId, input) =>
        this.executionOwnershipCoordinator.expireDeadOwner(sessionId, input),
      inspectProcess: inspectProcessIdentity,
      isSessionExecutedHere: async (sessionId) => {
        if (!executionOwnershipNodeId) return false;
        const session = await db.getSession(sessionId);
        return session?.node_id === executionOwnershipNodeId;
      },
      logger: this.logger,
    });
  }

  /**
   * Task 실행 시작. fire-and-forget — 호출자가 *await하지 않는다*.
   *
   * task.executionPromise에 drain promise를 박아 *후속 shutdown/cancel*이 drain 가능.
   * promise 실패는 task.error에 박히고 status="error"로 전환.
   */
  startExecution(task: Task, agent: AgentProfile): Promise<void> {
    return this.startExecutionWithOwnership(
      task,
      agent,
      async (operation, start) => await this.executionOwnershipCoordinator.withSessionLease(
        task.agentSessionId,
        operation,
        start,
      ),
    );
  }

  private startExecutionUnderRecoveryLease(
    task: Task,
    agent: AgentProfile,
  ): Promise<void> {
    return this.startExecutionWithOwnership(
      task,
      agent,
      async (_operation, start) => await start(),
    );
  }

  private startExecutionWithOwnership(
    task: Task,
    agent: AgentProfile,
    runOwnedAttempt: (
      operation: "attach" | "spawn",
      start: () => Promise<void>,
    ) => Promise<void>,
  ): Promise<void> {
    const retainedRunner = task.runnerRetainedForClaudeBackground === true
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
    const backend = effectiveTaskBackend(task, agent);
    if (!this.supportsExecutionOwnership()) {
      const runner = retainedRunner ?? (this.runnerProcessFactory
        ? this.runnerProcessFactory(task, agent, backend, this.snapshotPersistenceFor(task))
        : createInProcessTaskRunnerRuntime(
            task.modelPresetBackend
              ? this.engineFactory(agent, backend)
              : this.engineFactory(agent),
          ));
      if (retainedRunner) {
        releaseTaskRunner(task, retainedRunner);
      }
      this.startExecutionWithRunner(task, agent, runner);
      return task.executionPromise!;
    }

    const activationHandoff = task.executionActivationHandoff;
    const activation = deferred<void>();
    task.executionActivationPromise = activation.promise;
    void activation.promise.catch(() => undefined);
    if (activationHandoff) {
      void activation.promise.then(
        () => activationHandoff.resolve(),
        (error) => activationHandoff.reject(error),
      ).finally(() => {
        if (task.executionActivationHandoff === activationHandoff) {
          task.executionActivationHandoff = undefined;
        }
      });
    }
    const promise = this.startOwnedExecution(
      task,
      agent,
      backend,
      retainedRunner,
      () => activation.resolve(undefined),
      runOwnedAttempt,
    ).catch(
      async (err: unknown) => {
        activation.reject(err);
        if (isExecutionOwnershipConflictError(err)) {
          // Recovery scans consult this so they stop re-attempting a session
          // faster than the rejection said was worth trying.
          this.executionOwnershipBackoff?.observeConflict(
            task.agentSessionId,
            err.retryAt,
          );
          this.logger.warn(
            {
              err,
              sessionId: task.agentSessionId,
              retryAt: err.retryAt,
              reason: err.reason,
            },
            "Execution ownership conflict deferred to durable delivery recovery",
          );
          return;
        }
        this.executionOwnershipBackoff?.clear(task.agentSessionId);
        if (err instanceof RunnerOrphanedSpawnError) {
          this.logger.error(
            { err, sessionId: task.agentSessionId, proof: err.proof },
            "Spawned runner parent initialization failed; recovery owns the live child",
          );
          return;
        }
        await this.engineFailureRecovery.recoverFromOuterExecutionFailure(task, err);
        task.completedAt = new Date();
        await this._finalize(task);
      },
    );
    return this.holdExecutionSlot(task, promise);
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
      if (task.executionPromise === promise) task.executionPromise = undefined;
    };
    void promise.then(release, release);
    return promise;
  }

  private async startOwnedExecution(
    task: Task,
    agent: AgentProfile,
    backend: BackendId,
    retainedRunner: TaskRunnerRuntime | undefined,
    resolveActivation: () => void,
    runOwnedAttempt: (
      operation: "attach" | "spawn",
      start: () => Promise<void>,
    ) => Promise<void>,
  ): Promise<void> {
    // An attempt that lost to an owner it then proved dead has displaced the
    // only thing in its way, and giving up there left the session waiting on a
    // "durable delivery recovery" that had already consumed its message -- so
    // nothing ever reserved again. In the lab the expiry and the surrender
    // land in the same millisecond, and the session never speaks again.
    //
    // One retry is the whole fix: the corpse is now `failed`, and a second
    // conflict means somebody genuinely holds the session.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await runOwnedAttempt(
          retainedRunner ? "attach" : "spawn",
          async () => await this.startOwnedExecutionLocked(
            task,
            agent,
            backend,
            retainedRunner,
            resolveActivation,
          ),
        );
        return;
      } catch (error) {
        if (
          attempt >= 1
          || !isExecutionOwnershipConflictError(error)
          || !error.blockingOwnerDisplaced
        ) throw error;
        this.logger.info(
          { sessionId: task.agentSessionId, phase: error.phase },
          "retrying the execution reservation that displaced a dead owner",
        );
      }
    }
  }

  private async startOwnedExecutionLocked(
    task: Task,
    agent: AgentProfile,
    backend: BackendId,
    retainedRunner: TaskRunnerRuntime | undefined,
    resolveActivation: () => void,
  ): Promise<void> {
    const deferredUntil = this.executionOwnershipBackoff?.deferUntil(
      task.agentSessionId,
    );
    if (deferredUntil) {
      throw new ExecutionOwnershipConflictError(
        task.agentSessionId,
        deferredUntil,
        "active",
      );
    }
    const entryPath: ExecutionEntryPath =
      task.pendingExecutionExpectedTerminalEventId !== undefined
        ? "auto_resume"
        : "initial";
    const descriptor = await this.executionOwnerDescriptor(agent, backend);
    const ownershipGeneration = newExecutionOwnershipGeneration();
    task.executionOwnership = undefined;
    let stage: ExecutionReservationStage = "reserve";
    let reservationAttempted = false;
    let activated = false;
    let runner: TaskRunnerRuntime | undefined;
    let proof: import("./execution_ownership.js").ExecutionIdentityProof | undefined;
    try {
      reservationAttempted = true;
      const reservation = await this.executionOwnershipCoordinator
        .reserve(task.agentSessionId, {
          ownershipGeneration,
          ownerKind: descriptor.ownerKind,
          manifestId: descriptor.manifestId,
          runtimeEnvIdentity: descriptor.runtimeEnvIdentity,
        });
      applyCanonicalSessionProjection(task, reservation.canonicalSession);
      if (!this.executionOwnershipCoordinator.isAppliedOrSameOwner(reservation, {
        ownershipGeneration,
        ownerKind: descriptor.ownerKind,
        manifestId: descriptor.manifestId,
        runtimeEnvIdentity: descriptor.runtimeEnvIdentity,
        phases: ["reserved", "identity_proven", "active"],
      })) {
        throw this.executionOwnershipConflict(task.agentSessionId, reservation);
      }
      this.executionOwnershipBackoff?.clear(task.agentSessionId);
      task.executionOwnershipReservation = {
        ...descriptor,
        ownershipGeneration,
        entryPath,
      };

      stage = "spawn";
      runner = retainedRunner ?? (this.runnerProcessFactory
        ? this.runnerProcessFactory(task, agent, backend, this.snapshotPersistenceFor(task))
        : createInProcessTaskRunnerRuntime(
            task.modelPresetBackend
              ? this.engineFactory(agent, backend)
              : this.engineFactory(agent),
          ));
      if (retainedRunner) {
        releaseTaskRunner(task, retainedRunner);
      }
      if (task.runner) {
        throw new Error(
          `Task ${task.agentSessionId} already has a runner — concurrent execute not supported`,
        );
      }
      this.attachRunner(task, runner);
      proof = await runner.dispatcher.prepareExecutionIdentity?.();
      if (!proof || !isCompleteExecutionIdentity(proof)) {
        throw new Error(`Runner identity proof unavailable: ${task.agentSessionId}`);
      }
      stage = "prove";
      const proofApplication = await this.executionOwnershipCoordinator
        .prove(
          task.agentSessionId,
          ownershipGeneration,
          proof,
        );
      if (!this.executionOwnershipCoordinator.isAppliedOrSameOwner(proofApplication, {
        ownershipGeneration,
        ...proof,
        phases: ["identity_proven", "active"],
      })) {
        throw this.executionOwnershipConflict(task.agentSessionId, proofApplication);
      }
      stage = "prepare_session";
      await runner.dispatcher.prepareSession(task.agentSessionId);
      stage = "activate";
      const activation = await this.executionOwnershipCoordinator
        .activate(task.agentSessionId, {
          ownershipGeneration,
          reviewState: task.reviewState ?? "not_required",
          ...(task.pendingExecutionExpectedTerminalEventId === undefined
            ? {}
            : {
                expectedTerminalEventId:
                  task.pendingExecutionExpectedTerminalEventId,
              }),
        });
      applyCanonicalSessionProjection(task, activation.canonicalSession);
      if (!this.executionOwnershipCoordinator.isAppliedOrSameOwner(activation, {
        ownershipGeneration,
        ...proof,
        phases: ["active"],
      })) {
        throw this.executionOwnershipConflict(task.agentSessionId, activation);
      }
      activated = true;
      task.executionOwnership = {
        ...descriptor,
        ...proof,
        ownershipGeneration,
      };
      task.executionOwnershipReservation = undefined;
      task.recoveredExecutionOwnership = undefined;
      task.runnerTerminalFact = undefined;
      task.pendingExecutionExpectedTerminalEventId = undefined;
      resolveActivation();
      stage = "restore";
      await this.restoreDurableRunnerInterventions(task, runner);
      await this._consumeEventStream(task, runner, agent);
    } catch (error) {
      if (reservationAttempted && !activated) {
        throw await this.compensateUnactivatedExecution({
          task,
          ownershipGeneration,
          stage,
          runner,
          proof,
          error,
          label: "Execution",
        });
      }
      throw error;
    }
  }

  private executionOwnershipConflict(
    sessionId: string,
    application: Awaited<ReturnType<ExecutionOwnershipCoordinator["reserve"]>>,
  ): ExecutionOwnershipConflictError {
    const ownership = application.canonicalExecutionOwnership;
    const retryAt = new Date(Date.now() + 60_000).toISOString();
    return new ExecutionOwnershipConflictError(
      sessionId,
      retryAt,
      ownership?.phase ?? "reserved",
      ownership ?? undefined,
    );
  }

  private async compensateUnactivatedExecution(params: {
    task: Task;
    ownershipGeneration: number;
    stage: ExecutionReservationStage;
    runner: TaskRunnerRuntime | undefined;
    proof: import("./execution_ownership.js").ExecutionIdentityProof | undefined;
    error: unknown;
    label: "Execution" | "Adopted execution";
  }): Promise<unknown> {
    const {
      task,
      ownershipGeneration,
      stage,
      runner,
      proof,
      label,
    } = params;
    let error = params.error;
    const orphaned = error instanceof RunnerOrphanedSpawnError ? error : undefined;
    if (!orphaned && runner) {
      try {
        if (proof && runner.dispatcher.rollbackExecutionIdentity) {
          await runner.dispatcher.rollbackExecutionIdentity(proof);
        } else {
          await runner.dispatcher.close();
        }
      } catch (rollbackError) {
        if (rollbackError instanceof RunnerOrphanedSpawnError) {
          error = rollbackError;
        } else {
          this.logger.error(
            { err: rollbackError, sessionId: task.agentSessionId, ownershipGeneration, stage },
            `${label} runner rollback cleanup failed after ownership rejection`,
          );
        }
      }
    }

    if (error instanceof RunnerOrphanedSpawnError) {
      await this.projectOrphanedSpawn(task, ownershipGeneration, error);
      task.executionOwnershipReservation = undefined;
      if (runner) releaseTaskRunner(task, runner);
      return error;
    }

    const failureReason = `execution ${stage} failed: ${errorMessage(error)}`;
    try {
      const failure = await this.executionOwnershipCoordinator.fail(
        task.agentSessionId,
        ownershipGeneration,
        failureReason,
      );
      if (
        isExecutionOwnershipConflictError(error)
        && this.executionOwnershipCoordinator.isAppliedOrSameOwner(failure, {
          ownershipGeneration,
          phases: ["failed"],
        })
      ) {
        error.retryImmediately();
      } else if (isExecutionOwnershipConflictError(error)) {
        // Failing our own generation cannot dislodge the owner that beat us.
        // If that owner's process is gone, nothing else ever will.
        const outcome = await this.executionOwnershipExpiry.expireIfOwnerIsGone(
          task.agentSessionId,
          error.ownership,
        );
        if (outcome === "expired") {
          this.executionOwnershipBackoff?.clear(task.agentSessionId);
          error.displaceBlockingOwner();
        }
      }
    } catch (failureError) {
      this.logger.error(
        { err: failureError, sessionId: task.agentSessionId, ownershipGeneration, stage },
        `${label} ownership failure projection failed`,
      );
    }
    task.executionOwnershipReservation = undefined;
    if (runner) releaseTaskRunner(task, runner);
    return error;
  }

  private async projectOrphanedSpawn(
    task: Task,
    ownershipGeneration: number,
    error: RunnerOrphanedSpawnError,
  ): Promise<void> {
    try {
      const orphaned = await this.executionOwnershipCoordinator.markOrphanedSpawn(
        task.agentSessionId,
        ownershipGeneration,
        error.proof,
      );
      if (!this.executionOwnershipCoordinator.isAppliedOrSameOwner(orphaned, {
        ownershipGeneration,
        ...error.proof,
        phases: ["identity_proven"],
        failureReason: "orphaned_spawn",
      })) {
        this.logger.error(
          { sessionId: task.agentSessionId, ownershipGeneration },
          "Orphaned spawn ownership projection conflicted with the canonical owner",
        );
      }
    } catch (projectionError) {
      this.logger.error(
        { err: projectionError, sessionId: task.agentSessionId, ownershipGeneration },
        "Orphaned spawn ownership projection failed; recovery lease will expire safely",
      );
    }
  }

  private async executionOwnerDescriptor(
    agent: AgentProfile,
    backend: BackendId,
  ): Promise<{ ownerKind: ExecutionOwnerKind; manifestId: string; runtimeEnvIdentity: string }> {
    // A new ownership generation describes the runtime that will execute it.
    // Historical runner identity remains authoritative only in the adoption path.
    if (this.runnerProcessFactory) {
      const descriptor = await this.runnerProcessFactory.describe?.(agent);
      if (!descriptor) throw new Error("Runner process manifest descriptor unavailable");
      return descriptor;
    }
    return {
      ownerKind: "in_process",
      manifestId: `in-process:${backend}`,
      runtimeEnvIdentity: `in-process:${backend}:${agent.id}`,
    };
  }

  private supportsExecutionOwnership(): boolean {
    return typeof this.persistence.reserveExecutionOwnershipAndWaitForApplication === "function";
  }

  async releaseRetainedClaudeRunner(task: Task): Promise<void> {
    await this.executorFinalizer.releaseRetainedClaudeRunner(task);
  }

  startExecutionWithRunner(
    task: Task,
    agent: AgentProfile,
    runner: TaskRunnerRuntime,
  ): void {
    if (task.runner) {
      throw new Error(
        `Task ${task.agentSessionId} already has a runner — concurrent execute not supported`,
      );
    }
    this.attachRunner(task, runner);

    const promise = (async () => {
      await runner.dispatcher.prepareSession(task.agentSessionId);
      await this.restoreDurableRunnerInterventions(task, runner);
      await this._consumeEventStream(task, runner, agent);
    })().catch(
      async (err: unknown) => {
        // _consumeEventStream 내부 try/catch가 못 잡는 외부 throw용 안전망.
        await this.engineFailureRecovery.recoverFromOuterExecutionFailure(task, err);
        task.completedAt = new Date();
        await this._finalize(task);
      },
    );
    this.holdExecutionSlot(task, promise);
  }

  /** Reattaches host-side consumption to an execution already owned by a runner child. */
  recoverRunnerExecution(
    task: Task,
    agent: AgentProfile,
    runner: TaskRunnerRuntime,
    commandId?: string,
    mode: "adopt" | "replay" | "offline" = "adopt",
    manifestId?: string,
    runtimeEnvIdentity?: string,
  ): Promise<void> {
    return this.withSessionRecoveryLease(
      task.agentSessionId,
      async () => await this.recoverRunnerExecutionLocked(
        task,
        agent,
        runner,
        commandId,
        mode,
        manifestId,
        runtimeEnvIdentity,
      ),
    );
  }

  withSessionRecoveryLease<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.executionOwnershipCoordinator.withSessionLease(
      sessionId,
      "recovery",
      operation,
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
  ): Promise<void> {
    if (mode === "adopt" && manifestId && this.supportsExecutionOwnership()) {
      const runnerRuntimeEnvIdentity = runtimeEnvIdentity ?? `legacy:${manifestId}`;
      return this.recoverOwnedRunnerExecutionLocked(
        task,
        agent,
        runner,
        manifestId,
        runnerRuntimeEnvIdentity,
        commandId,
      );
    }
    if (task.runner) {
      throw new Error(`Task ${task.agentSessionId} already has a runner`);
    }
    const frames = runner.dispatcher.recoverFrames?.(commandId);
    if (!frames) throw new Error("runner dispatcher does not support execution recovery");
    this.attachRunner(task, runner, mode === "offline");
    if (mode === "offline") task.status = "running";
    const promise = (async () => {
      // Adoption must establish the same durable running projection as a new
      // turn before replaying runner frames. A stable execution command id
      // suppresses duplicate client updates across repeated host restarts.
      if (mode === "adopt") {
        const application = await this.persistence
          .enqueueRunningTransitionAndWaitForApplication(
          task.agentSessionId,
          {
            reviewState: task.reviewState ?? "not_required",
            transitionId: `adopt:${commandId ?? task.lastEventId}`,
          },
        );
        applyCanonicalSessionProjection(task, application.canonicalSession);
        if (!application.applied) {
          throw new Error(
            `runner adoption running transition rejected for ${task.agentSessionId}`,
          );
        }
      }
      await this.consumeRecoveredRunnerFrames(
        task,
        agent,
        runner,
        frames,
        mode === "adopt",
      );
    })();
    this.holdExecutionSlot(task, promise);
    return promise;
  }

  private recoverOwnedRunnerExecutionLocked(
    task: Task,
    agent: AgentProfile,
    runner: TaskRunnerRuntime,
    manifestId: string,
    runtimeEnvIdentity: string,
    commandId?: string,
  ): Promise<void> {
    const deferredUntil = this.executionOwnershipBackoff?.deferUntil(
      task.agentSessionId,
    );
    if (deferredUntil) {
      throw new ExecutionOwnershipConflictError(
        task.agentSessionId,
        deferredUntil,
        "active",
      );
    }
    if (task.runner) {
      throw new Error(`Task ${task.agentSessionId} already has a runner`);
    }
    task.executionOwnership = undefined;
    this.attachRunner(task, runner);
    const ownershipGeneration = newExecutionOwnershipGeneration();
    let reservationAttempted = false;
    let activated = false;
    let stage: ExecutionReservationStage = "reserve";
    let proof: import("./execution_ownership.js").ExecutionIdentityProof | undefined;
    const promise = (async () => {
      try {
        proof = await runner.dispatcher.prepareExecutionIdentity?.(commandId);
        if (!proof || !isCompleteExecutionIdentity(proof)) {
          throw new Error(`Adopted runner identity proof unavailable: ${task.agentSessionId}`);
        }
        reservationAttempted = true;
        const reservation = await this.executionOwnershipCoordinator
          .reserveAdoption(task.agentSessionId, {
            ownershipGeneration,
            manifestId,
            runtimeEnvIdentity,
            previousRegistrationId: proof.registrationId,
            pid: proof.pid,
            startIdentity: proof.startIdentity,
            executionCommandId: proof.executionCommandId,
          });
        applyCanonicalSessionProjection(task, reservation.canonicalSession);
        if (!this.executionOwnershipCoordinator.isAppliedOrSameOwner(reservation, {
          ownershipGeneration,
          ownerKind: "adopted_runner",
          manifestId,
          runtimeEnvIdentity,
          phases: ["reserved", "identity_proven", "active"],
        })) {
          throw this.executionOwnershipConflict(task.agentSessionId, reservation);
        }
        this.executionOwnershipBackoff?.clear(task.agentSessionId);
        task.executionOwnershipReservation = {
          ownerKind: "adopted_runner",
          manifestId,
          runtimeEnvIdentity,
          ownershipGeneration,
          entryPath: "adopt",
        };
        stage = "prove";
        const proofApplication = await this.executionOwnershipCoordinator
          .prove(
            task.agentSessionId,
            ownershipGeneration,
            proof,
          );
        if (!this.executionOwnershipCoordinator.isAppliedOrSameOwner(proofApplication, {
          ownershipGeneration,
          ...proof,
          phases: ["identity_proven", "active"],
        })) {
          throw this.executionOwnershipConflict(task.agentSessionId, proofApplication);
        }
        stage = "activate";
        const activation = await this.executionOwnershipCoordinator
          .activate(task.agentSessionId, {
            ownershipGeneration,
            reviewState: task.reviewState ?? "not_required",
          });
        applyCanonicalSessionProjection(task, activation.canonicalSession);
        if (!this.executionOwnershipCoordinator.isAppliedOrSameOwner(activation, {
          ownershipGeneration,
          ...proof,
          phases: ["active"],
        })) {
          throw this.executionOwnershipConflict(task.agentSessionId, activation);
        }
        activated = true;
        task.executionOwnership = {
          ownerKind: "adopted_runner",
          manifestId,
          runtimeEnvIdentity,
          ownershipGeneration,
          ...proof,
        };
        task.executionOwnershipReservation = undefined;
        const frames = runner.dispatcher.recoverFrames?.(commandId);
        if (!frames) throw new Error("runner dispatcher does not support execution recovery");
        await this.consumeRecoveredRunnerFrames(task, agent, runner, frames, true);
      } catch (error) {
        if (reservationAttempted && !activated) {
          throw await this.compensateUnactivatedExecution({
            task,
            ownershipGeneration,
            stage,
            runner,
            proof,
            error,
            label: "Adopted execution",
          });
        }
        throw error;
      }
    })();
    this.holdExecutionSlot(task, promise);
    return promise;
  }

  recoverRegisteredRunner(
    task: Task,
    registration: RunnerRegistration,
    commandId: string | undefined,
    mode: "adopt" | "replay" | "offline",
    onAttemptCreated?: (runner: TaskRunnerRuntime) => void,
  ): Promise<void> {
    const config = registration.config;
    const runner = this.runnerProcessFactory?.recover?.(
      task,
      registration,
      this.snapshotPersistenceFor(task),
      mode,
    );
    if (!runner) throw new Error("runner process recovery factory unavailable");
    onAttemptCreated?.(runner);
    return this.recoverRunnerExecutionLocked(
      task,
      config.agent,
      runner,
      commandId,
      mode,
      config.releaseManifestId ?? config.codeSha,
      config.runtimeEnvIdentity ?? `legacy:${config.codeSha}`,
    ).catch(async (error: unknown) => {
      await this.releaseUnadoptedRunner(task, runner, config.sessionId);
      throw error;
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
   * Only the registration is given back. The child process keeps running and,
   * critically, keeps its host request channel: a runner mid-tool is waiting
   * on a host request, and aborting that leaves the tool without a result --
   * the turn then never finishes and its output never reaches the user (lab
   * F9 regression, old turn stuck at tool_start with no tool_result).
   */
  private async releaseUnadoptedRunner(
    task: Task,
    runner: TaskRunnerRuntime,
    sessionId: string,
  ): Promise<void> {
    if (task.runner === runner) return;
    try {
      await runner.dispatcher.releaseEventStreamRegistration?.();
    } catch (err) {
      this.logger.warn(
        { err, sessionId },
        "unadopted runner event stream release failed; the stream may stay registered",
      );
    }
  }

  restartRegisteredRunner(task: Task, config: RunnerChildConfig): Promise<void> {
    if (this.supportsExecutionOwnership()) {
      return this.startExecution(task, config.agent);
    }
    const runner = this.runnerProcessFactory?.restart?.(
      task,
      config,
      this.snapshotPersistenceFor(task),
    );
    if (!runner) throw new Error("runner process restart factory unavailable");
    this.startExecutionWithRunner(task, config.agent, runner);
    return task.executionPromise!;
  }

  restartRegisteredRunnerUnderRecoveryLease(
    task: Task,
    config: RunnerChildConfig,
  ): Promise<void> {
    if (this.supportsExecutionOwnership()) {
      return this.startExecutionUnderRecoveryLease(task, config.agent);
    }
    const runner = this.runnerProcessFactory?.restart?.(
      task,
      config,
      this.snapshotPersistenceFor(task),
    );
    if (!runner) throw new Error("runner process restart factory unavailable");
    this.startExecutionWithRunner(task, config.agent, runner);
    return task.executionPromise!;
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

  async failScheduledClaudeRuntimeFollowupsForShutdown(): Promise<void> {
    if (!this.claudeRuntimeTaskFollowup) return;
    for (const { task, message, reason } of this.claudeRuntimeTaskFollowup.takeScheduledFallbacks()) {
      await this.handleScheduledClaudeRuntimeFollowupFailure(
        task,
        message,
        reason,
        new Error("server shutdown while delayed retry was scheduled"),
      );
    }
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
   *   - generator throw → status="error" → loop 종료.
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
    const initialTurnInput = await this.turnInputBuilder.prepareInitialTurnInput(task, agent);
    try {
      await this.consumeTurnLoop(task, agent, runner, initialTurnInput);
    } finally {
      if (!isOpenAiAgentsApprovalPending(task)) {
        task.completedAt = new Date();
      }
      await this._finalize(task);
    }
  }

  private async consumeTurnLoop(
    task: Task,
    agent: AgentProfile,
    runner: TaskRunnerRuntime,
    initialTurnInput: TaskTurnInput,
  ): Promise<void> {
    let turnInput = initialTurnInput;
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
      const rolloverCycleFromForTurn = task.claudeBackendRolloverCycleFrom
        ?? turnInput.backendSessionRolloverFrom;
      const contextRecovery = createClaudeContextRecoveryObservation();
      let currentTurnIntervention = turnInput.intervention;
      if (currentTurnIntervention && this.claudeRuntimeTaskFollowup) {
        await this.claudeRuntimeTaskFollowup.cancelScheduledFallback(
          task,
          currentTurnIntervention,
        );
      }
      const compactedBeforeTurn = await this.compactClaudeContextIfNeeded(
        task,
        agent,
        runner,
        turnInput,
      );
      if (compactedBeforeTurn && currentTurnIntervention) {
        turnInput = await this.turnInputBuilder.prepareFollowupTurnInput(
          task,
          agent,
          currentTurnIntervention,
        );
        currentTurnIntervention = turnInput.intervention;
      }
      const previousAssistantText = normalizeAssistantText(task.lastAssistantText);
      const turnReceipt = this.deliveryConsumption
        ? new TaskDeliveryTurnReceipt(
            this.deliveryConsumption,
            currentTurnIntervention,
          )
        : undefined;
      try {
        for await (const event of this.engineTurnRunner.executeTurn({
          task,
          agent,
          runner,
          input: {
            prompt: turnInput.prompt,
            ...(turnInput.inputUuid !== undefined
              ? { inputUuid: turnInput.inputUuid }
              : {}),
            ...(turnInput.runnerInterventionId !== undefined
              ? { runnerInterventionId: turnInput.runnerInterventionId }
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
          observeClaudeContextRecoveryEvent(contextRecovery, event);
          if (turnReceipt) await turnReceipt.observe(task, event);
          await this.engineEventPublisher.publishEngineEvent(task, event, {
            alreadyPersisted: runner.eventPersistence === "runner",
          });
          this.collectClaudeRuntimeTaskFollowup(task, event);
        }
      } catch (err) {
        await this.engineFailureRecovery.recoverFromExecuteFailure(task, err);
        break;
      }
      try {
      const lastAcknowledgedEventId = runner.eventPersistence === "runner"
        ? await runner.dispatcher.waitForSessionAck()
        : await this.persistence.waitForSessionAck(task.agentSessionId);
      if (lastAcknowledgedEventId !== null) {
        task.lastEventId = lastAcknowledgedEventId;
      }
      task.claudeContextUsage = contextRecovery.compactCompleted
        ? undefined
        : contextRecovery.latestContextUsage ?? task.claudeContextUsage;
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
          task.claudeContextUsage = undefined;
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
      if (
        contextRecovery.preemptiveCompactNeeded
        && !contextRecovery.compactCompleted
      ) {
        await this.compactClaudeContextIfNeeded(task, agent, runner);
      }
      await this.flushClaudeRuntimeTaskFollowups(task);
      await this.handleClaudeRuntimeFollowupStall(
        task,
        currentTurnIntervention,
        previousAssistantText,
      );
      await task.interruptRequest;
      const transition = resolveTurnLoopTransition(task, agent);
      if (transition.kind === "awaiting_runtime") {
        await this.publishPendingClaudeRuntimeAfterTurnError(task);
        break;
      }
      if (transition.kind !== "continue") break;
      turnInput = await this.turnInputBuilder.prepareFollowupTurnInput(
        task,
        agent,
        transition.intervention,
      );
      } finally {
        if (turnReceipt) await turnReceipt.consume(task);
      }
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
    try {
      await (runner.engine as EnginePort & SupportsCompact).compact(task.codexThreadId);
      await this.engineEventPublisher.publishEngineEvent(task, {
        type: "compact",
        trigger: "auto_preemptive",
        message: "Claude session compacted (auto_preemptive)",
      } as SSEEventPayload);
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
      task.claudeContextUsage = undefined;
    }
  }

  private async consumeRecoveredRunnerFrames(
    task: Task,
    agent: AgentProfile,
    runner: TaskRunnerRuntime,
    frames: AsyncIterable<import("../runner/frame_protocol.js").RunnerEventFrame>,
    propagateFailure: boolean,
  ): Promise<void> {
    const contextRecovery = createClaudeContextRecoveryObservation();
    let recoveryFailed = false;
    let recoveryFailure: unknown;
    try {
      for await (const event of this.engineTurnRunner.recoverTurn(task, runner, frames)) {
        observeClaudeContextRecoveryEvent(contextRecovery, event);
        await this.engineEventPublisher.publishEngineEvent(task, event, {
          alreadyPersisted: true,
        });
        this.collectClaudeRuntimeTaskFollowup(task, event);
      }
      const lastAcknowledgedEventId = await runner.dispatcher.waitForSessionAck();
      if (lastAcknowledgedEventId !== null) task.lastEventId = lastAcknowledgedEventId;
      task.claudeContextUsage = contextRecovery.compactCompleted
        ? undefined
        : contextRecovery.latestContextUsage ?? task.claudeContextUsage;
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
      await this.restoreDurableRunnerInterventions(task, runner);
      await task.interruptRequest;
      const transition = resolveTurnLoopTransition(task, agent);
      if (transition.kind === "awaiting_runtime") {
        await this.publishPendingClaudeRuntimeAfterTurnError(task);
      } else if (transition.kind === "continue") {
        const followupTurnInput = await this.turnInputBuilder.prepareFollowupTurnInput(
          task,
          agent,
          transition.intervention,
        );
        await this.consumeTurnLoop(task, agent, runner, followupTurnInput);
      }
    } catch (error) {
      await this.engineFailureRecovery.recoverFromExecuteFailure(task, error);
      recoveryFailed = true;
      recoveryFailure = error;
    } finally {
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
      await this._finalize(task);
    }
    // Startup adoption owns a live child. Its caller must be able to re-check
    // that ownership and replace a dead/unreachable registration. Offline
    // terminal replay intentionally keeps the historical swallow-and-finalize
    // contract because the durable terminal error is the replay result.
    if (recoveryFailed && propagateFailure) throw recoveryFailure;
  }

  private async restoreDurableRunnerInterventions(
    task: Task,
    runner: TaskRunnerRuntime,
  ): Promise<void> {
    const recover = runner.dispatcher.recoverPendingInterventions;
    if (!recover) return;
    for (const pending of await recover.call(runner.dispatcher)) {
      const text = pending.message.text;
      const user = pending.message.user;
      if (typeof text !== "string" || typeof user !== "string") {
        throw new Error(`runner intervention payload is invalid: ${pending.interventionId}`);
      }
      const message = {
        ...(pending.message as unknown as InterventionMessage),
        text,
        user,
        runnerInterventionId: pending.interventionId,
      };
      if (message.deliveryId) {
        const discarded = await this.deliveryConsumption?.discardIfConsumed(
          task,
          message,
        ) ?? false;
        if (discarded) continue;
        const admitted = task.interventionQueue.find(
          (queued) => queued.deliveryId === message.deliveryId,
        );
        if (admitted) {
          admitted.runnerInterventionId = pending.interventionId;
          continue;
        }
      }
      enqueueInterventionOnce(task, message);
    }
  }

  private async publishPendingClaudeRuntimeAfterTurnError(task: Task): Promise<void> {
    const failedTasks = failBlockingClaudeRuntimeWork(
      task,
      CLAUDE_RUNTIME_PENDING_AFTER_TURN_MESSAGE,
    );
    await this.engineEventPublisher.publishEngineEvent(task, {
      type: "error",
      message: `${CLAUDE_RUNTIME_PENDING_AFTER_TURN_MESSAGE} Pending task(s): ${failedTasks
        .map((runtimeTask) => runtimeTask.taskId)
        .join(", ") || "unknown"}.`,
      error_code: "claude_runtime_pending_after_turn",
      fatal: true,
      recoverable: true,
      recovery_hint: "Send another message to resume this session in a fresh turn.",
    } as SSEEventPayload);
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

  private async handleClaudeRuntimeFollowupStall(
    task: Task,
    intervention: InterventionMessage | undefined,
    previousAssistantText: string,
  ): Promise<boolean> {
    if (intervention?.source !== CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE) return false;
    const nextAssistantText = normalizeAssistantText(task.lastAssistantText);
    const reason = resolveFollowupStallReason(previousAssistantText, nextAssistantText);
    if (!reason) return false;

    const attempt = intervention.followupAttempt ?? 1;
    if (attempt < MAX_CLAUDE_RUNTIME_FOLLOWUP_ATTEMPT && this.claudeRuntimeTaskFollowup) {
      try {
        const scheduledFallback = this.claudeRuntimeTaskFollowup.queueFallback(
          task,
          intervention,
          reason,
        );
        await scheduledFallback.reserved;
        void scheduledFallback.completed.catch((err: unknown) => {
          void this.handleScheduledClaudeRuntimeFollowupFailure(task, intervention, reason, err);
        });
        return true;
      } catch (err) {
        this.logger.warn(
          {
            err,
            sessionId: task.agentSessionId,
            followupAttempt: attempt,
            followupKey: intervention.followupKey,
            reason,
          },
          "Claude runtime task follow-up fallback enqueue failed",
        );
        await this.publishClaudeRuntimeFollowupRetryFailed(task, err);
        return true;
      }
    }

    await this.publishClaudeRuntimeFollowupExhausted(task, attempt);
    return true;
  }

  private async handleScheduledClaudeRuntimeFollowupFailure(
    task: Task,
    intervention: InterventionMessage,
    reason: ClaudeRuntimeFollowupStallReason,
    err: unknown,
  ): Promise<void> {
    try {
      if (task.status === "running") {
        this.logger.info(
          { sessionId: task.agentSessionId, followupKey: intervention.followupKey },
          "Claude runtime task follow-up delayed failure ignored after another turn resumed",
        );
        return;
      }
      this.logger.warn(
        {
          err,
          sessionId: task.agentSessionId,
          followupAttempt: intervention.followupAttempt ?? 1,
          followupKey: intervention.followupKey,
          reason,
        },
        "Claude runtime task follow-up delayed fallback enqueue failed",
      );
      await this.publishClaudeRuntimeFollowupRetryFailed(task, err);
      task.completedAt = new Date();
      await this._finalize(task);
    } catch (finalizeErr) {
      this.logger.error(
        { err: finalizeErr, sessionId: task.agentSessionId },
        "Claude runtime task follow-up delayed failure finalization failed",
      );
    }
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

  private async publishClaudeRuntimeFollowupRetryFailed(
    task: Task,
    err: unknown,
  ): Promise<void> {
    const message =
      `Background task follow-up retry could not be queued: ${formatErrorMessage(err)}. ` +
      "Automatic follow-up cannot continue; send another message to resume and inspect the background task result.";
    task.status = "error";
    task.error = message;
    await this.engineEventPublisher.publishEngineEvent(task, {
      type: "error",
      message,
      error_code: "claude_runtime_followup_stalled",
      fatal: true,
      recoverable: true,
      recovery_hint:
        "Send another message to resume this session in a fresh turn and inspect the background task result.",
    } as SSEEventPayload);
  }

  private async publishClaudeRuntimeFollowupExhausted(
    task: Task,
    attempt: number,
  ): Promise<void> {
    const message =
      `Background task follow-up did not produce a new response after ${attempt} attempt(s); ` +
      "automatic retries were exhausted. Send another message to resume and inspect the background task result.";
    task.status = "error";
    task.error = message;
    await this.engineEventPublisher.publishEngineEvent(task, {
      type: "error",
      message,
      error_code: "claude_runtime_followup_stalled",
      fatal: true,
      recoverable: true,
      recovery_hint:
        "Send another message to resume this session in a fresh turn and inspect the background task result.",
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

  private async _finalize(task: Task): Promise<void> {
    await this.executorFinalizer.finalize(task);
  }
}

type ExecutionReservationStage =
  | "reserve"
  | "spawn"
  | "prove"
  | "prepare_session"
  | "activate"
  | "restore";

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
): ClaudeRuntimeFollowupStallReason | null {
  if (!nextAssistantText) return "empty_response";
  if (previousAssistantText && nextAssistantText === previousAssistantText) {
    return "repeated_response";
  }
  return null;
}

function formatErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
