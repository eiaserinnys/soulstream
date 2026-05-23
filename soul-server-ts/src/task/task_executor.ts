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
  SSEEventPayload,
} from "../engine/protocol.js";
import { CLAUDE_OAUTH_TOKEN_ENV } from "../engine/claude_options.js";
import type { EventPersistence } from "../db/event_persistence.js";
import type { SessionDB } from "../db/session_db.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";
import type { ExecutionContextBuilder } from "../context/context_builder.js";

import type { CompletionNotifier } from "./completion_notifier.js";
import { TaskAgentsSnapshotPersistence } from "./task_agents_snapshot_persistence.js";
import { TaskEngineEventPublisher } from "./task_engine_event_publisher.js";
import { TaskInitialMessagePublisher } from "./task_initial_message_publisher.js";
import { TaskLifecycleTransition } from "./task_lifecycle_transition.js";
import type { Task, TaskStatus } from "./task_models.js";
import {
  isOpenAiAgentsApprovalPending,
  resolveTurnLoopTransition,
} from "./task_turn_loop_transition.js";
import { TaskTurnInputBuilder } from "./task_turn_input_builder.js";

/** AgentProfile → EnginePort 생성. backend별 분기는 factory 구현체 담당. */
export type EngineFactory = (agent: AgentProfile) => EnginePort;

export class TaskExecutor {
  private readonly engineEventPublisher: TaskEngineEventPublisher;
  private readonly lifecycleTransition: TaskLifecycleTransition;
  private readonly initialMessagePublisher: TaskInitialMessagePublisher;
  private readonly agentsSnapshotPersistence: TaskAgentsSnapshotPersistence;
  private readonly turnInputBuilder: TaskTurnInputBuilder;

  constructor(
    private readonly engineFactory: EngineFactory,
    db: SessionDB,
    persistence: EventPersistence,
    private readonly broadcaster: SessionBroadcaster,
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
    private readonly completionNotifier?: CompletionNotifier,
  ) {
    this.lifecycleTransition = new TaskLifecycleTransition({
      db,
      broadcaster,
      logger,
    });
    this.engineEventPublisher = new TaskEngineEventPublisher({
      broadcaster,
      db,
      logger,
      persistence,
    });
    this.initialMessagePublisher = new TaskInitialMessagePublisher({
      broadcaster,
      logger,
      persistence,
    });
    this.turnInputBuilder = new TaskTurnInputBuilder({
      contextBuilder,
      initialMessagePublisher: this.initialMessagePublisher,
      logger,
    });
    this.agentsSnapshotPersistence = new TaskAgentsSnapshotPersistence({
      db,
      logger,
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
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(
          { err, sessionId: task.agentSessionId },
          "Task execution threw outside event stream",
        );
        task.status = "error";
        task.error = message;
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
    let turnImageAttachmentPaths: string[] | undefined = initialTurnInput.imageAttachmentPaths;
    let turnSystemPrompt = initialTurnInput.systemPrompt;
    try {
      while (true) {
        const resumeSessionId = task.codexThreadId;
        try {
          const effectiveAllowedTools = task.allowedTools ?? agent.allowed_tools;
          const effectiveDisallowedTools = task.disallowedTools ?? agent.disallowed_tools;
          // Running interventions stay in task.interventionQueue until this turn
          // completes. Pushing a second user message into an active Claude SDK
          // turn can terminate resumed sessions with `[ede_diagnostic]
          // result_type=user`, so Claude and Codex share the same turn-between
          // queue semantics here.
          const onIntervention = undefined;
          const queuedToolApproval = task.agentsQueuedToolApproval;
          task.agentsQueuedToolApproval = undefined;
          for await (const event of engine.execute({
            prompt: turnPrompt,
            imageAttachmentPaths: turnImageAttachmentPaths,
            model: task.model,
            reasoningEffort: task.reasoningEffort,
            resumeSessionId,
            resumeRunState: task.agentsRunState,
            previousResponseId: task.agentsPreviousResponseId,
            conversationId: task.agentsConversationId,
            sessionItems: task.agentsSessionItems,
            ...(queuedToolApproval ? { queuedToolApproval } : {}),
            extraEnv: buildTaskExtraEnv(task),
            onRunStateSnapshot: (snapshot) =>
              this.agentsSnapshotPersistence.persistRunStateSnapshot(task, snapshot),
            onSessionItemsSnapshot: (snapshot) =>
              this.agentsSnapshotPersistence.persistSessionItemsSnapshot(task, snapshot),
            // Phase B parity: 첫 turn에 한해 systemPrompt가 SDK 옵션으로 전달됨. intervention turn은
            // resumeSessionId로 이어붙기 때문에 SDK가 기존 system prompt를 유지 — turnSystemPrompt가 undefined로 흘러 미전달.
            ...(turnSystemPrompt !== undefined ? { systemPrompt: turnSystemPrompt } : {}),
            // Phase B parity: 요청별 도구 권한이 있으면 우선하고, 없으면 agents.yaml 값을 forward
            // (Python `effective_allowed_tools` 정합). claude 어댑터만 SDK에 매핑하며, codex는 무시.
            ...(effectiveAllowedTools !== undefined ? { allowedTools: effectiveAllowedTools } : {}),
            ...(effectiveDisallowedTools !== undefined
              ? { disallowedTools: effectiveDisallowedTools }
              : {}),
            ...(task.useMcp !== undefined ? { useMcp: task.useMcp } : {}),
            ...(agent.max_turns !== undefined ? { maxTurns: agent.max_turns } : {}),
            ...(onIntervention ? { onIntervention } : {}),
          })) {
            await this.engineEventPublisher.publishEngineEvent(task, event);
          }
        } catch (err) {
          // engine.execute()가 throw — interrupted 가능 (AbortController)
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            { err, sessionId: task.agentSessionId },
            "engine.execute drain threw",
          );
          if (task.status === "running") {
            task.status = "error";
            task.error = message;
          }
          // P1-3 (code-reviewer): turn이 throw로 끝났을 때 interventionQueue에 미처리
          // 메시지가 있으면 *침묵 손실*. 사용자는 addIntervention 시 intervention_sent
          // broadcast를 받아 "보냈다"고 인지했으나 실제로는 처리되지 않음. 명시 error
          // 이벤트를 wire에 발행하여 클라이언트가 재전송 의도 결정할 수 있게 한다.
          if (task.interventionQueue.length > 0) {
            const skipped = task.interventionQueue.length;
            task.interventionQueue = [];  // 재처리 방지
            try {
              await this.broadcaster.emitEventEnvelope(task.agentSessionId, {
                type: "error",
                message: `Turn failed; ${skipped} queued intervention(s) skipped`,
                fatal: false,
              } as SSEEventPayload);
            } catch (e) {
              this.logger.warn(
                { err: e, sessionId: task.agentSessionId },
                "queue-skipped error broadcast failed",
              );
            }
          }
          break;
        }
        // turn 정상 종료 — 외부에서 status가 interrupted 등으로 박혔는지, queue가 남았는지 결정
        const transition = resolveTurnLoopTransition(task, agent);
        if (transition.kind !== "continue") {
          break;
        }
        turnPrompt = transition.prompt;
        turnImageAttachmentPaths = transition.imageAttachmentPaths;
        turnSystemPrompt = undefined;
        // (intervention_sent는 addIntervention에서 이미 broadcast됨 — 여기서 재발행 안 함.)
      }
    } finally {
      if (!isOpenAiAgentsApprovalPending(task)) {
        task.completedAt = new Date();
      }
      await this._finalize(task);
    }
  }

  /**
   * 종료 처리: DB sessions 업데이트 + session_updated broadcast + engine.close.
   */
  private async _finalize(task: Task): Promise<void> {
    await this.lifecycleTransition.persistExecutorFinalState(task);

    // engine 정리
    try {
      await task.engine?.close();
    } catch (err) {
      this.logger.warn(
        { err, sessionId: task.agentSessionId },
        "engine.close failed",
      );
    }
    task.engine = undefined;

    // B-7 피위임 완료 회송 — callerSessionId가 있고 notifier가 주입된 경우만.
    // notifier 내부가 자체 격리(local 실패→orch 폴백→양쪽 실패해도 resolve)하지만 안전망 추가.
    // Python `task_manager.py:439-442` 정본 정합 — finalize의 락 블록 *바깥*에서 호출 (TS는
    // 단일 task 인스턴스에 락이 없어 _finalize 안에서 호출해도 동치).
    if (task.callerSessionId && this.completionNotifier) {
      try {
        await this.completionNotifier.notify(task);
      } catch (err) {
        // notifier는 자체 격리하지만 안전망 — finalize는 절대 실패 전파 안 함.
        this.logger.warn(
          { err, sessionId: task.agentSessionId },
          "completionNotifier.notify threw (should not happen — notifier is supposed to isolate)",
        );
      }
    }
  }
}

/** 외부 검증용 — task가 종료 상태인지. */
export function isTerminalStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "error" || status === "interrupted";
}

function buildTaskExtraEnv(task: Task): Record<string, string> | undefined {
  if (!task.oauthToken) {
    return undefined;
  }
  return { [CLAUDE_OAUTH_TOKEN_ENV]: task.oauthToken };
}
