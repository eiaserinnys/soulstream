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
  EngineRunStateSnapshot,
  EngineSessionItemsSnapshot,
  SSEEventPayload,
} from "../engine/protocol.js";
import { CLAUDE_OAUTH_TOKEN_ENV } from "../engine/claude_options.js";
import {
  shouldPersistEvent,
  type EventPersistence,
} from "../db/event_persistence.js";
import type { SessionDB } from "../db/session_db.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";
import {
  composeFirstTurnPrompt,
  type ExecutionContextBuilder,
  type PreparedContext,
} from "../context/context_builder.js";

import type { CompletionNotifier } from "./completion_notifier.js";
import { splitAttachmentPaths } from "./attachment_context.js";
import { TaskInitialMessagePublisher } from "./task_initial_message_publisher.js";
import { TaskLifecycleTransition } from "./task_lifecycle_transition.js";
import type { Task, TaskStatus } from "./task_models.js";
import {
  composeInterventionTurnPrompt,
  isOpenAiAgentsApprovalPending,
  resolveTurnLoopTransition,
} from "./task_turn_loop_transition.js";

/** AgentProfile → EnginePort 생성. backend별 분기는 factory 구현체 담당. */
export type EngineFactory = (agent: AgentProfile) => EnginePort;

export class TaskExecutor {
  private readonly lifecycleTransition: TaskLifecycleTransition;
  private readonly initialMessagePublisher: TaskInitialMessagePublisher;

  constructor(
    private readonly engineFactory: EngineFactory,
    private readonly db: SessionDB,
    private readonly persistence: EventPersistence,
    private readonly broadcaster: SessionBroadcaster,
    private readonly logger: Logger,
    /**
     * B-6 context_builder DI. undefined일 때 본 PR 이전 동작(task.prompt 직접 사용) 유지 —
     * legacy 호출자·테스트 환경 호환. 운영 흐름(main.ts)에서는 항상 주입.
     */
    private readonly contextBuilder?: ExecutionContextBuilder,
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
    this.initialMessagePublisher = new TaskInitialMessagePublisher({
      broadcaster,
      logger,
      persistence,
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
    // B-5 진입 분기: auto-resume 흐름과 신규 task 흐름 구분.
    //
    // - 신규 task (queue 비어있음): task.prompt가 사용자의 첫 발화 → user_message 영속화 후
    //   첫 turn engine.execute(prompt=task.prompt).
    // - Auto-resume (queue 비어있지 않음, PR #55 결함 A 정정 반영):
    //   `addIntervention.completed/error/interrupted` 분기(`_addInterventionAutoResume`)가
    //   *user_message를 이미 영속화·broadcast*했고 task.status="running"으로 전환 + queue.push +
    //   session_updated wire까지 발행한 상태. 첫 turn은 queue dequeue로 *새 메시지를 prompt*로
    //   사용. 추가 user_message 영속화는 *완전한 의미 중복* — skip.
    //
    // Python 정본은 auto-resume 시 *새 task를 생성*(`task_manager.add_intervention` L635
    // `create_task(prompt=text, ...)`)하여 새 _persist_initial_messages가 user_message를
    // 박는 모델. TS는 같은 task 인스턴스를 재활용하지만 본 분기 + addIntervention auto-resume
    // 분기 조합으로 wire 의미 등가 달성.
    let turnPrompt: string;
    let turnImageAttachmentPaths: string[] | undefined;
    /**
     * 첫 turn에 backend별로 분리하여 SDK에 전달할 system prompt.
     *
     * Phase B parity 분기 (분석 캐시 §E-2):
     * - claude backend: SDK `system_prompt` 옵션을 활용 → composeFirstTurnPrompt에는 system 제외하고
     *   context items만 prepend, systemPrompt는 EngineExecuteParams로 별도 전달.
     * - codex backend: SDK turn-level systemPrompt 미지원 → 기존 동작 그대로 prompt 본문에 prepend.
     */
    let turnSystemPrompt: string | undefined;
    if (task.interventionQueue.length === 0) {
      // 신규 task — Python `_persist_initial_messages`(L120-182) 정합.
      //
      // 순서 (Python L131-180):
      //   1. ctx = contextBuilder.build (있으면)
      //   2. system_message 영속화·broadcast (ctx.effectiveSystemPrompt 있을 때)
      //   3. user_message 영속화·broadcast (payload.context = ctx.combinedContextItems)
      //   4. turn prompt 합성 (codex SDK는 turn-level systemPrompt 미지원이라 단일 문자열로 prepend)
      //
      // ctx를 *먼저* build해야 (2)(3)(4) 모두에 같은 산출물을 forward할 수 있다 — Python 정본도
      // _persist_initial_messages 호출 직전 ctx를 인자로 받는다. PR #57은 (4)만 이식했고
      // (2)(3) wire emit이 누락되어 대시보드 ⚙️ 시스템 프롬프트 / 📋 Context 슬롯이 비어
      // 보였다 — 분석 캐시 `20260518-0945-codex-context-mcp-cancel.md` Part A-3a.
      //
      // contextBuilder 미주입(legacy 호출자·테스트)이면 ctx=undefined → (2) skip, (3) context
      // 키 생략, (4) task.prompt 그대로. Python `if ... and ctx.effective_system_prompt` 가드와
      // 같은 의미 (L134).
      //
      // Auto-resume·intervention turn은 본 분기에 진입하지 않으므로 system_prompt·atom_context
      // 재주입 안 함 (Python `_resolve_folder` L100 `task.resume_session_id is None` 정합).
      let ctx: PreparedContext | undefined;
      if (this.contextBuilder) {
        try {
          ctx = await this.contextBuilder.build(task, agent);
        } catch (err) {
          this.logger.warn(
            { err, sessionId: task.agentSessionId },
            "context_builder failed — falling back to task.prompt without context",
          );
        }
      }

      // 영속화 실패는 격리 — 본 task 진행에 영향 0 (Python L179-180 try/except 정합).
      await this.initialMessagePublisher.publishInitialMessages(task, ctx);

      if (ctx) {
        if (agent.backend === "claude") {
          // claude: SDK가 turn-level system_prompt를 직접 받음 → 분리.
          // composeFirstTurnPrompt에는 effectiveSystemPrompt를 비워 전달하여 prompt 본문에 prepend되지 않도록.
          // context items는 SDK가 모르는 정보이므로 그대로 prepend.
          turnPrompt = composeFirstTurnPrompt({
            effectiveSystemPrompt: undefined,
            combinedContextItems: ctx.combinedContextItems,
            assembledPrompt: task.prompt,
          });
          turnSystemPrompt = ctx.effectiveSystemPrompt;
        } else {
          // codex: SDK가 turn-level systemPrompt 미지원 → 기존 동작 (prompt 본문에 prepend).
          turnPrompt = composeFirstTurnPrompt({
            ...ctx,
            assembledPrompt: task.prompt,
          });
        }
      } else {
        turnPrompt = task.prompt;
      }
      turnImageAttachmentPaths = splitAttachmentPaths(task.attachmentPaths).imagePaths;
    } else {
      // Auto-resume — user_message는 addIntervention 분기가 이미 영속화. 첫 turn은 dequeue.
      const composed = composeInterventionTurnPrompt(task.interventionQueue.shift()!);
      turnPrompt = composed.prompt;
      turnImageAttachmentPaths = composed.imageAttachmentPaths;
    }
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
              this._persistAgentsRunStateSnapshot(task, snapshot),
            onSessionItemsSnapshot: (snapshot) =>
              this._persistAgentsSessionItemsSnapshot(task, snapshot),
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
            await this._processEvent(task, event);
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
   * 단일 이벤트 처리: 필요 시 DB 영속 + broadcast + side effect.
   *
   * - 첫 session 이벤트: task.codexThreadId 박기 + DB sessions.claude_session_id 영속화 (F-3B).
   *   stored proc session_set_claude_id가 idempotent하므로 race에도 안전.
   * - persistEvent / setClaudeSessionId 실패는 격리 (logger.warn) — 본 task 진행 중단 회피.
   */
  private async _processEvent(
    task: Task,
    event: SSEEventPayload,
  ): Promise<void> {
    const eventType = (event as { type: string }).type;

    // 첫 session 이벤트에서 thread id 박기 + DB 영속화
    if (eventType === "session") {
      const sid = (event as { session_id?: unknown }).session_id;
      if (typeof sid === "string" && !task.codexThreadId) {
        task.codexThreadId = sid;
        // F-3B: sessions.claude_session_id 컬럼 영속화 — 노드 재시작 시 thread 이어붙임 전제.
        try {
          await this.db.setClaudeSessionId(task.agentSessionId, sid);
        } catch (err) {
          this.logger.warn(
            { err, sessionId: task.agentSessionId, threadId: sid },
            "setClaudeSessionId failed — thread id not persisted",
          );
        }
      }
    }

    // DB 영속 — 실패 격리. event dict에 `_event_id` 박기 (Python `task_executor.py:248` 의미 등가).
    // ride-along 5자리(분석 캐시 `20260518-1338-codex-live-event-id-race.md`): orch session_events.py가
    // wire envelope의 `event._event_id`로 SSE id를 추출 → 대시보드 tree-placer가 dedup·순서 보장.
    // 누락 시 모든 live 이벤트가 `eventId=0`으로 같은 키 취급되어 text_start skip → text_delta/end 미박힘.
    // 단, app-server `_live_only` 텍스트 조각은 생성 중 wire 전용이다. DB에 저장하면 완성 답변이
    // delta 조각으로 중복 보존되므로 영속화와 cursor id 부여를 건너뛴다.
    //
    // throw 경로 의도적 차이 (spec-reviewer P2-1): Python L243-248은 try/except *밖*에서
    // `_event_id = None`을 박지만, TS는 try 안에서만 박는다 (throw 시 키 자체 부재).
    // orch session_events.py:L172-176가 None 또는 키 부재 둘 다 `event_id is None` 분기로
    // 처리하므로 wire 동작은 동등. test에서 throw 격리 단언으로 검증.
    if (shouldPersistEvent(event)) {
      try {
        const eventId = await this.persistence.persistEvent(
          task.agentSessionId,
          event,
        );
        task.lastEventId = eventId;
        (event as Record<string, unknown>)._event_id = eventId;
      } catch (err) {
        this.logger.warn(
          { err, sessionId: task.agentSessionId, eventType },
          "persistEvent failed",
        );
      }
    }

    // orch broadcast — 실패 격리
    //
    // 라이브 진단 trace (분석 캐시 `20260518-1218-codex-sse-realtime-sync.md` P1-A): silent succeed
    // 시점에 호출 자체가 일어났는지 확정하기 위해 dispatch 직전·직후 logger.info 박기. LOG_LEVEL=info
    // 운영 환경에서 emit 흐름을 가시화. 가설 X(subscribe_events 미구현 간접 차단) fix-forward가
    // 무실효일 경우, 가설 Y(emit 호출 안 됨) vs Z(silent fail) 결정적 격리를 *같은 라이브 배포*로
    // 가능하게 한다 — fix-forward 사이클 1회 단축.
    this.logger.info(
      { sessionId: task.agentSessionId, eventType },
      "emitEventEnvelope dispatch",
    );
    try {
      await this.broadcaster.emitEventEnvelope(task.agentSessionId, event);
      this.logger.info(
        { sessionId: task.agentSessionId, eventType },
        "emitEventEnvelope completed",
      );
    } catch (err) {
      this.logger.warn(
        { err, sessionId: task.agentSessionId, eventType },
        "emitEventEnvelope failed",
      );
    }

    // side effect (last_message + task.lastAssistantText)
    try {
      await this.persistence.handleSideEffects(task.agentSessionId, event, task);
    } catch (err) {
      this.logger.warn(
        { err, sessionId: task.agentSessionId, eventType },
        "handleSideEffects threw",
      );
    }
  }

  private async _persistAgentsRunStateSnapshot(
    task: Task,
    snapshot: EngineRunStateSnapshot,
  ): Promise<void> {
    if (snapshot.backendId !== "openai-agents") return;

    task.agentsRunState = snapshot.serialized ?? undefined;
    task.agentsPendingApprovalId = snapshot.pendingApprovalId ?? undefined;
    task.agentsPreviousResponseId = snapshot.previousResponseId ?? undefined;
    task.agentsConversationId = snapshot.conversationId ?? undefined;
    task.agentsRunStateSchemaVersion = snapshot.schemaVersion ?? undefined;

    const metadata = replaceMetadataEntry(task.metadata, {
      type: "agents_run_state",
      value: {
        backend: "openai-agents",
        serialized: snapshot.serialized,
        pendingApprovalId: snapshot.pendingApprovalId ?? null,
        previousResponseId: snapshot.previousResponseId ?? null,
        conversationId: snapshot.conversationId ?? null,
        schemaVersion: snapshot.schemaVersion ?? null,
        updatedAt: new Date().toISOString(),
      },
    });
    task.metadata = metadata;
    try {
      await this.db.updateSession(task.agentSessionId, { metadata });
    } catch (err) {
      this.logger.warn(
        { err, sessionId: task.agentSessionId },
        "agents_run_state metadata update failed",
      );
    }
  }

  private async _persistAgentsSessionItemsSnapshot(
    task: Task,
    snapshot: EngineSessionItemsSnapshot,
  ): Promise<void> {
    if (snapshot.backendId !== "openai-agents") return;

    task.agentsSessionItems = snapshot.items;
    const metadata = replaceMetadataEntry(task.metadata, {
      type: "agents_session_items",
      value: {
        backend: "openai-agents",
        items: snapshot.items,
        updatedAt: new Date().toISOString(),
      },
    });
    task.metadata = metadata;
    try {
      await this.db.updateSession(task.agentSessionId, { metadata });
    } catch (err) {
      this.logger.warn(
        { err, sessionId: task.agentSessionId },
        "agents_session_items metadata update failed",
      );
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

function replaceMetadataEntry(
  metadata: Array<Record<string, unknown>> | undefined,
  entry: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const type = entry.type;
  const next = (metadata ?? []).filter((item) => item.type !== type);
  next.push(entry);
  return next;
}
