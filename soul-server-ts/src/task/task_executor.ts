/**
 * TaskExecutor — Task 실행 흐름 (Phase B-3).
 *
 * 책임:
 *   1. EnginePort 인스턴스를 engineFactory(agent)로 생성
 *   2. task.engine 설정 (cancelTask가 interrupt 신호 보낼 수 있도록)
 *   3. engine.execute() AsyncIterable drain
 *   4. 매 yield 이벤트: 저장 대상은 persistEvent → emitEventEnvelope → handleSideEffects,
 *      `_live_only`는 영속화 없이 emitEventEnvelope → handleSideEffects
 *   5. session event 첫 yield: task.codexThreadId 박기
 *   6. 종료 시: status 전환 + DB session_update + session_updated broadcast
 *
 * Codex 단일턴 — _consumeEventStream이 generator 완료까지 drain하면 task 종료.
 * 멀티턴/idle 전환은 B-4.
 */

import type { Logger } from "pino";

import type { AgentProfile } from "../agent_registry.js";
import type {
  EnginePort,
  ScheduleToolUseHandler,
  SSEEventPayload,
} from "../engine/protocol.js";
import type { EventPersistence } from "../db/event_persistence.js";
import type { SessionDB, SupervisorRegistryRow } from "../db/session_db.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";
import type { ExecutionContextBuilder } from "../context/context_builder.js";
import type { SupervisorWakeScheduler } from "../supervisor/wake_router.js";
import type { SupervisorHandoverPolicyOptions } from "../supervisor/handover_policy.js";

import type { CompletionNotifier } from "./completion_notifier.js";
import { TaskExecutorFinalizer } from "./task_executor_finalizer.js";
import { TaskEngineFailureRecovery } from "./task_engine_failure_recovery.js";
import { TaskAgentsSnapshotPersistence } from "./task_agents_snapshot_persistence.js";
import { TaskEngineEventPublisher } from "./task_engine_event_publisher.js";
import { TaskEngineTurnRunner } from "./task_engine_turn_runner.js";
import { TaskInitialMessagePublisher } from "./task_initial_message_publisher.js";
import { publishInterventionSent } from "./task_intervention_events.js";
import { TaskLifecycleTransition } from "./task_lifecycle_transition.js";
import type { Task, TaskStatus } from "./task_models.js";
import {
  isOpenAiAgentsApprovalPending,
  resolveTurnLoopTransition,
} from "./task_turn_loop_transition.js";
import { TaskTurnInputBuilder } from "./task_turn_input_builder.js";
import { failBlockingClaudeRuntimeWork } from "./claude_runtime_state.js";
import {
  CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
  type ClaudeRuntimeFollowupStallReason,
  type ClaudeRuntimeTaskFollowupPort,
} from "./claude_runtime_task_followup.js";
import type { InterventionMessage } from "./task_models.js";

const CLAUDE_RUNTIME_PENDING_AFTER_TURN_MESSAGE =
  "Claude runtime session remained active after the engine turn ended; marking this turn failed so follow-up messages can resume.";

/** AgentProfile → EnginePort 생성. backend별 분기는 factory 구현체 담당. */
export type EngineFactory = (agent: AgentProfile) => EnginePort;

export class TaskExecutor {
  private readonly engineEventPublisher: TaskEngineEventPublisher;
  private readonly engineFailureRecovery: TaskEngineFailureRecovery;
  private readonly lifecycleTransition: TaskLifecycleTransition;
  private readonly executorFinalizer: TaskExecutorFinalizer;
  private readonly initialMessagePublisher: TaskInitialMessagePublisher;
  private readonly agentsSnapshotPersistence: TaskAgentsSnapshotPersistence;
  private readonly engineTurnRunner: TaskEngineTurnRunner;
  private readonly turnInputBuilder: TaskTurnInputBuilder;
  private readonly interventionEventDeps: {
    broadcaster: SessionBroadcaster;
    logger: Logger;
    persistence: EventPersistence;
  };

  constructor(
    private readonly engineFactory: EngineFactory,
    db: SessionDB,
    persistence: EventPersistence,
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
     * Python `soul-server/src/soul_server/service/task_manager.py:439-442
     * _notify_caller_completion` 정본의 codex 적응판 (분석 캐시
     * `roselin/.local/artifacts/analysis/20260518-2125-ts-delegation-return.md` §3-2).
     */
    completionNotifier?: CompletionNotifier,
    scheduleToolHandler?: ScheduleToolUseHandler,
    private readonly claudeRuntimeTaskFollowup?: ClaudeRuntimeTaskFollowupPort,
    supervisorWakeScheduler?: Pick<SupervisorWakeScheduler, "ingest">,
    sourceNode?: string,
    supervisorHandoverRunner?: { run(registry: SupervisorRegistryRow): Promise<void> },
    supervisorHandoverPolicy?: Pick<
      SupervisorHandoverPolicyOptions,
      "softTokenThreshold" | "hardTokenThreshold"
    >,
  ) {
    this.lifecycleTransition = new TaskLifecycleTransition({
      db,
      broadcaster,
      logger: this.logger,
      sourceNode,
      supervisorWakeScheduler,
    });
    this.executorFinalizer = new TaskExecutorFinalizer({
      lifecycleTransition: this.lifecycleTransition,
      logger: this.logger,
      completionNotifier,
    });
    this.engineEventPublisher = new TaskEngineEventPublisher({
      broadcaster,
      db,
      logger: this.logger,
      persistence,
      sourceNode,
      supervisorWakeScheduler,
      supervisorHandoverRunner,
      supervisorHandoverPolicy,
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
    this.interventionEventDeps = {
      broadcaster,
      logger: this.logger,
      persistence,
    };
    this.turnInputBuilder = new TaskTurnInputBuilder({
      contextBuilder,
      initialMessagePublisher: this.initialMessagePublisher,
      logger: this.logger,
    });
    this.agentsSnapshotPersistence = new TaskAgentsSnapshotPersistence({
      db,
      logger: this.logger,
    });
    this.engineTurnRunner = new TaskEngineTurnRunner({
      snapshotPersistence: this.agentsSnapshotPersistence,
      scheduleToolHandler,
    });
  }

  /**
   * Task 실행 시작. fire-and-forget — 호출자가 *await하지 않는다*.
   *
   * task.executionPromise에 drain promise를 박아 *후속 shutdown/cancel*이 drain 가능.
   * promise 실패는 task.error에 박히고 status="error"로 전환.
   */
  startExecution(task: Task, agent: AgentProfile): void {
    if (task.engine) {
      throw new Error(
        `Task ${task.agentSessionId} already has an engine — concurrent execute not supported`,
      );
    }
    const engine = this.engineFactory(agent);
    task.engine = engine;

    const promise = this._consumeEventStream(task, engine, agent).catch(
      async (err: unknown) => {
        // _consumeEventStream 내부 try/catch가 못 잡는 외부 throw용 안전망.
        await this.engineFailureRecovery.recoverFromOuterExecutionFailure(task, err);
        task.completedAt = new Date();
        await this._finalize(task);
      },
    );
    task.executionPromise = promise;
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
    engine: EnginePort,
    agent: AgentProfile,
  ): Promise<void> {
    const initialTurnInput = await this.turnInputBuilder.prepareInitialTurnInput(task, agent);
    let turnPrompt = initialTurnInput.prompt;
    let turnImageAttachmentPaths = initialTurnInput.imageAttachmentPaths;
    let turnSystemPrompt = initialTurnInput.systemPrompt;
    let currentTurnIntervention = initialTurnInput.intervention;
    try {
      while (true) {
        const previousAssistantText = normalizeAssistantText(task.lastAssistantText);
        try {
          for await (const event of this.engineTurnRunner.executeTurn({
            task,
            agent,
            engine,
            input: {
              prompt: turnPrompt,
              imageAttachmentPaths: turnImageAttachmentPaths,
              ...(turnSystemPrompt !== undefined ? { systemPrompt: turnSystemPrompt } : {}),
            },
          })) {
            await this.engineEventPublisher.publishEngineEvent(task, event);
            this.collectClaudeRuntimeTaskFollowup(task, event);
          }
        } catch (err) {
          await this.engineFailureRecovery.recoverFromExecuteFailure(task, err);
          break;
        }
        await this.flushClaudeRuntimeTaskFollowups(task);
        await this.handleClaudeRuntimeFollowupStall(
          task,
          currentTurnIntervention,
          previousAssistantText,
        );
        // turn 정상 종료 — 외부에서 status가 interrupted 등으로 박혔는지, queue가 남았는지 결정
        const transition = resolveTurnLoopTransition(task, agent);
        if (transition.kind === "awaiting_runtime") {
          await this.publishPendingClaudeRuntimeAfterTurnError(task);
          break;
        }
        if (transition.kind !== "continue") {
          break;
        }
        await publishInterventionSent(task, transition.intervention, this.interventionEventDeps);
        const followupTurnInput = await this.turnInputBuilder.prepareFollowupTurnInput(
          task,
          agent,
          transition.intervention,
        );
        turnPrompt = followupTurnInput.prompt;
        turnImageAttachmentPaths = followupTurnInput.imageAttachmentPaths;
        turnSystemPrompt = followupTurnInput.systemPrompt;
        currentTurnIntervention = transition.intervention;
      }
    } finally {
      if (!isOpenAiAgentsApprovalPending(task)) {
        task.completedAt = new Date();
      }
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
    }
  }

  private async handleClaudeRuntimeFollowupStall(
    task: Task,
    intervention: InterventionMessage | undefined,
    previousAssistantText: string,
  ): Promise<void> {
    if (intervention?.source !== CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE) return;
    const nextAssistantText = normalizeAssistantText(task.lastAssistantText);
    const reason = resolveFollowupStallReason(previousAssistantText, nextAssistantText);
    if (!reason) return;

    await this.engineEventPublisher.publishEngineEvent(task, {
      type: "error",
      message:
        "Background task follow-up did not produce a new response. Please send a follow-up message manually.",
      error_code: "claude_runtime_followup_stalled",
      fatal: false,
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
