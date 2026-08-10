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

import type { CompletionNotifier } from "./completion_notifier.js";
import { TaskExecutorFinalizer } from "./task_executor_finalizer.js";
import { TaskEngineFailureRecovery } from "./task_engine_failure_recovery.js";
import { TaskAgentsSnapshotPersistence } from "./task_agents_snapshot_persistence.js";
import { TaskEngineEventPublisher } from "./task_engine_event_publisher.js";
import { TaskEngineTurnRunner } from "./task_engine_turn_runner.js";
import { TaskInitialMessagePublisher } from "./task_initial_message_publisher.js";
import { TaskLifecycleTransition } from "./task_lifecycle_transition.js";
import type { InterventionMessage, Task, TaskStatus } from "./task_models.js";
import {
  isOpenAiAgentsApprovalPending,
  resolveTurnLoopTransition,
} from "./task_turn_loop_transition.js";
import { TaskTurnInputBuilder } from "./task_turn_input_builder.js";
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
    config: RunnerChildConfig,
    snapshots: RunnerSnapshotPersistence,
    mode?: "adopt" | "offline",
  ): TaskRunnerRuntime;
  restart?(
    task: Task,
    config: RunnerChildConfig,
    snapshots: RunnerSnapshotPersistence,
  ): TaskRunnerRuntime;
}

export interface RunnerSnapshotPersistence {
    persistRunState(snapshot: import("../engine/protocol.js").EngineRunStateSnapshot): Promise<void>;
    persistSessionItems(
      snapshot: import("../engine/protocol.js").EngineSessionItemsSnapshot,
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
      "recordConsumed" | "recordTurnStarted"
    >,
    private readonly modelCatalog?: Pick<ModelCatalog, "resolve">,
    private readonly runnerProcessFactory?: RunnerProcessRuntimeFactory,
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
  }

  /**
   * Task 실행 시작. fire-and-forget — 호출자가 *await하지 않는다*.
   *
   * task.executionPromise에 drain promise를 박아 *후속 shutdown/cancel*이 drain 가능.
   * promise 실패는 task.error에 박히고 status="error"로 전환.
   */
  startExecution(task: Task, agent: AgentProfile): void {
    if (task.runner) {
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
    const runner = this.runnerProcessFactory
      ? this.runnerProcessFactory(task, agent, backend, {
          persistRunState: async (snapshot) =>
            await this.agentsSnapshotPersistence.persistRunStateSnapshot(task, snapshot),
          persistSessionItems: async (snapshot) =>
            await this.agentsSnapshotPersistence.persistSessionItemsSnapshot(task, snapshot),
        })
      : createInProcessTaskRunnerRuntime(
          task.modelPresetBackend
            ? this.engineFactory(agent, backend)
            : this.engineFactory(agent),
        );
    this.startExecutionWithRunner(task, agent, runner);
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
    task.runner = runner;

    const promise = (async () => {
      await runner.dispatcher.prepareSession(task.agentSessionId);
      await this._consumeEventStream(task, runner, agent);
    })().catch(
      async (err: unknown) => {
        // _consumeEventStream 내부 try/catch가 못 잡는 외부 throw용 안전망.
        await this.engineFailureRecovery.recoverFromOuterExecutionFailure(task, err);
        task.completedAt = new Date();
        await this._finalize(task);
      },
    );
    task.executionPromise = promise;
  }

  /** Reattaches host-side consumption to an execution already owned by a runner child. */
  recoverRunnerExecution(
    task: Task,
    agent: AgentProfile,
    runner: TaskRunnerRuntime,
    commandId?: string,
  ): Promise<void> {
    if (task.runner) {
      throw new Error(`Task ${task.agentSessionId} already has a runner`);
    }
    const frames = runner.dispatcher.recoverFrames?.(commandId);
    if (!frames) throw new Error("runner dispatcher does not support execution recovery");
    task.runner = runner;
    task.status = "running";
    const promise = this.consumeRecoveredRunnerFrames(task, agent, runner, frames);
    task.executionPromise = promise;
    return promise;
  }

  recoverRegisteredRunner(
    task: Task,
    config: RunnerChildConfig,
    commandId: string | undefined,
    mode: "adopt" | "offline",
  ): Promise<void> {
    const runner = this.runnerProcessFactory?.recover?.(
      task,
      config,
      this.snapshotPersistenceFor(task),
      mode,
    );
    if (!runner) throw new Error("runner process recovery factory unavailable");
    return this.recoverRunnerExecution(
      task,
      config.agent,
      runner,
      commandId,
    );
  }

  restartRegisteredRunner(task: Task, config: RunnerChildConfig): void {
    const runner = this.runnerProcessFactory?.restart?.(
      task,
      config,
      this.snapshotPersistenceFor(task),
    );
    if (!runner) throw new Error("runner process restart factory unavailable");
    this.startExecutionWithRunner(task, config.agent, runner);
  }

  private snapshotPersistenceFor(task: Task): RunnerSnapshotPersistence {
    return {
      persistRunState: async (snapshot) =>
        await this.agentsSnapshotPersistence.persistRunStateSnapshot(task, snapshot),
      persistSessionItems: async (snapshot) =>
        await this.agentsSnapshotPersistence.persistSessionItemsSnapshot(task, snapshot),
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
    const { engine } = runner;
    const initialTurnInput = await this.turnInputBuilder.prepareInitialTurnInput(task, agent);
    let turnPrompt = initialTurnInput.prompt;
    let turnImageAttachmentPaths = initialTurnInput.imageAttachmentPaths;
    let turnSystemPrompt = initialTurnInput.systemPrompt;
    let turnInputUuid = initialTurnInput.inputUuid;
    let currentTurnIntervention = initialTurnInput.intervention;
    try {
      while (true) {
        if (currentTurnIntervention && this.claudeRuntimeTaskFollowup) {
          this.claudeRuntimeTaskFollowup.cancelScheduledFallback(
            task,
            currentTurnIntervention,
          );
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
              prompt: turnPrompt,
              ...(turnInputUuid !== undefined ? { inputUuid: turnInputUuid } : {}),
              imageAttachmentPaths: turnImageAttachmentPaths,
              ...(turnSystemPrompt !== undefined ? { systemPrompt: turnSystemPrompt } : {}),
            },
          })) {
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
        const lastAcknowledgedEventId = runner.eventPersistence === "runner"
          ? await runner.dispatcher.waitForSessionAck()
          : await this.persistence.waitForSessionAck(task.agentSessionId);
        if (lastAcknowledgedEventId !== null) {
          task.lastEventId = lastAcknowledgedEventId;
        }
        await this.flushClaudeRuntimeTaskFollowups(task);
        const followupStalled = await this.handleClaudeRuntimeFollowupStall(
          task,
          currentTurnIntervention,
          previousAssistantText,
        );
        if (!followupStalled && turnReceipt) await turnReceipt.consume(task);
        // turn 정상 종료 — 외부에서 status가 interrupted 등으로 박혔는지, queue가 남았는지 결정
        const transition = resolveTurnLoopTransition(task, agent);
        if (transition.kind === "awaiting_runtime") {
          await this.publishPendingClaudeRuntimeAfterTurnError(task);
          break;
        }
        if (transition.kind !== "continue") {
          break;
        }
        const followupTurnInput = await this.turnInputBuilder.prepareFollowupTurnInput(
          task,
          agent,
          transition.intervention,
        );
        turnPrompt = followupTurnInput.prompt;
        turnImageAttachmentPaths = followupTurnInput.imageAttachmentPaths;
        turnSystemPrompt = followupTurnInput.systemPrompt;
        turnInputUuid = followupTurnInput.inputUuid;
        currentTurnIntervention = transition.intervention;
      }
    } finally {
      if (!isOpenAiAgentsApprovalPending(task)) {
        task.completedAt = new Date();
      }
      await this._finalize(task);
    }
  }

  private async consumeRecoveredRunnerFrames(
    task: Task,
    agent: AgentProfile,
    runner: TaskRunnerRuntime,
    frames: AsyncIterable<import("../runner/frame_protocol.js").RunnerEventFrame>,
  ): Promise<void> {
    try {
      for await (const event of this.engineTurnRunner.recoverTurn(task, runner, frames)) {
        await this.engineEventPublisher.publishEngineEvent(task, event, {
          alreadyPersisted: true,
        });
        this.collectClaudeRuntimeTaskFollowup(task, event);
      }
      const lastAcknowledgedEventId = await runner.dispatcher.waitForSessionAck();
      if (lastAcknowledgedEventId !== null) task.lastEventId = lastAcknowledgedEventId;
      await this.flushClaudeRuntimeTaskFollowups(task);
      const transition = resolveTurnLoopTransition(task, agent);
      if (transition.kind === "awaiting_runtime") {
        await this.publishPendingClaudeRuntimeAfterTurnError(task);
      } else if (transition.kind === "continue") {
        throw new Error("recovered runner cannot contain an unpersisted intervention queue");
      }
    } catch (error) {
      await this.engineFailureRecovery.recoverFromExecuteFailure(task, error);
    } finally {
      try {
        const lastAcknowledgedEventId = await runner.dispatcher.waitForSessionAck();
        if (lastAcknowledgedEventId !== null) task.lastEventId = lastAcknowledgedEventId;
      } catch (error) {
        this.logger.warn(
          { error, sessionId: task.agentSessionId },
          "runner recovery ACK drain failed",
        );
      }
      task.completedAt = new Date();
      await this._finalize(task);
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
        void scheduledFallback.catch((err: unknown) => {
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
  private async _finalize(task: Task): Promise<void> {
    await this.executorFinalizer.finalize(task);
  }
}

/** 외부 검증용 — task가 종료 상태인지. */
export function isTerminalStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "error" || status === "interrupted";
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
