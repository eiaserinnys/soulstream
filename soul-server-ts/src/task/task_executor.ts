/**
 * TaskExecutor — Task 실행 흐름 (Phase B-3).
 *
 * 책임:
 *   1. EnginePort 인스턴스를 engineFactory(agent)로 생성
 *   2. task.engine 설정 (cancelTask가 interrupt 신호 보낼 수 있도록)
 *   3. engine.execute() AsyncIterable drain
 *   4. 매 yield 이벤트: persistEvent → emitEventEnvelope → handleSideEffects → task.lastEventId 갱신
 *   5. session event 첫 yield: task.codexThreadId 박기
 *   6. 종료 시: status 전환 + DB session_update + session_updated broadcast
 *
 * Codex 단일턴 — _consumeEventStream이 generator 완료까지 drain하면 task 종료.
 * 멀티턴/idle 전환은 B-4.
 */

import type { Logger } from "pino";

import type { AgentProfile } from "../agent_registry.js";
import type { EnginePort, SSEEventPayload } from "../engine/protocol.js";
import type { EventPersistence } from "../db/event_persistence.js";
import type { SessionDB } from "../db/session_db.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";
import {
  composeFirstTurnPrompt,
  type ExecutionContextBuilder,
  type PreparedContext,
} from "../context/context_builder.js";

import type { Task, TaskStatus } from "./task_models.js";

/** AgentProfile → EnginePort 생성. backend별 분기는 factory 구현체 담당. */
export type EngineFactory = (agent: AgentProfile) => EnginePort;

export class TaskExecutor {
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
  ) {}

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
      await this._persistInitialMessages(task, ctx);

      if (ctx) {
        turnPrompt = composeFirstTurnPrompt({
          ...ctx,
          assembledPrompt: task.prompt,
        });
      } else {
        turnPrompt = task.prompt;
      }
    } else {
      // Auto-resume — user_message는 addIntervention 분기가 이미 영속화. 첫 turn은 dequeue.
      turnPrompt = task.interventionQueue.shift()!.text;
    }
    try {
      while (true) {
        const resumeSessionId = task.codexThreadId;
        try {
          for await (const event of engine.execute({
            prompt: turnPrompt,
            model: task.model,
            resumeSessionId,
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
        // turn 정상 종료 — 외부에서 status가 interrupted 등으로 박혔으면 loop 종료
        if (task.status !== "running") {
          break;
        }
        // intervention queue 검사 — 비어있으면 completed, 있으면 다음 turn으로
        const next = task.interventionQueue.shift();
        if (!next) {
          task.status = "completed";
          break;
        }
        turnPrompt = next.text;
        // (intervention_sent는 addIntervention에서 이미 broadcast됨 — 여기서 재발행 안 함.)
      }
    } finally {
      task.completedAt = new Date();
      await this._finalize(task);
    }
  }

  /**
   * 단일 이벤트 처리: DB 영속 + broadcast + side effect.
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

    // DB 영속 — 실패 격리
    try {
      const eventId = await this.persistence.persistEvent(
        task.agentSessionId,
        event,
      );
      task.lastEventId = eventId;
    } catch (err) {
      this.logger.warn(
        { err, sessionId: task.agentSessionId, eventType },
        "persistEvent failed",
      );
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

  /**
   * 첫 turn 진입 *전*에 system_message + user_message 이벤트를 events 테이블에 영속화하고
   * wire로 broadcast.
   *
   * Python `task_executor.py:120-182 _persist_initial_messages` 정본 그대로 이식 (복수형).
   * 두 분기 모두 영속화·broadcast 됨으로써 대시보드의 ⚙️ 시스템 프롬프트 / 📋 Context (N)
   * 슬롯에 표시되는 데이터가 채워진다 — 분석 캐시 `20260518-0945-codex-context-mcp-cancel.md`
   * Part A-3a wire emit 누락 root cause 직접 해소.
   *
   * 1. system_message (ctx.effectiveSystemPrompt 있을 때, Python L133-146):
   *      {type: "system_message", text: effectiveSystemPrompt}
   *
   * 2. user_message (Python L148-180):
   *      {type: "user_message", user, text, caller_info?, context?, timestamp}
   *    - context 필드: ctx.combinedContextItems가 비어있지 않을 때만 추가 (Python은
   *      `ctx.combined_context_items` 무조건 박지만 빈 list면 dashboard 표시 0 — TS는 명시).
   *
   * PREVIEW_FIELD_MAP에 system_message는 *의도적 제외* (Python L298-305 정합) — last_message
   * wire에는 안 박힘. broadcast 자체는 정상 발화하므로 wire 구독자(orch dashboard)가 받아 표시.
   *
   * 부가 기능 — 실패는 격리 (Python L145-146·L179-180 try/except): 본 task 진행에 영향 0.
   */
  private async _persistInitialMessages(
    task: Task,
    ctx?: PreparedContext,
  ): Promise<void> {
    // 1. system_message 분기 — Python L133-146 정합
    //
    // Python 정본은 `{type, text}` 2키만 박는다 (task_executor.py L136-139).
    // soul-ui `shared/sse-events.ts SystemMessageEvent` type도 동일 2키.
    // 추가 키(timestamp 등)는 wire-schema 비대칭을 유발하므로 명시 제외.
    if (ctx?.effectiveSystemPrompt) {
      const sysEvent: Record<string, unknown> = {
        type: "system_message",
        text: ctx.effectiveSystemPrompt,
      };
      try {
        const eventId = await this.persistence.persistEvent(
          task.agentSessionId,
          sysEvent as SSEEventPayload,
        );
        task.lastEventId = eventId;
      } catch (err) {
        this.logger.warn(
          { err, sessionId: task.agentSessionId },
          "system_message persistEvent failed",
        );
      }
      try {
        await this.broadcaster.emitEventEnvelope(
          task.agentSessionId,
          sysEvent as SSEEventPayload,
        );
      } catch (err) {
        this.logger.warn(
          { err, sessionId: task.agentSessionId },
          "system_message broadcast failed",
        );
      }
      // handleSideEffects 호출 안 함 — PREVIEW_FIELD_MAP에 system_message 없음 (Python 정합).
    }

    // 2. user_message 분기 — Python L148-180 정합
    const event: Record<string, unknown> = {
      type: "user_message",
      user: task.callerInfo?.display_name ?? task.callerInfo?.user_id ?? "unknown",
      text: task.prompt,
      timestamp: Date.now() / 1000,
    };
    if (task.callerInfo) {
      event.caller_info = task.callerInfo;
    }
    if (ctx && ctx.combinedContextItems.length > 0) {
      event.context = ctx.combinedContextItems;
    }
    try {
      const eventId = await this.persistence.persistEvent(
        task.agentSessionId,
        event as SSEEventPayload,
      );
      task.lastEventId = eventId;
    } catch (err) {
      this.logger.warn(
        { err, sessionId: task.agentSessionId },
        "user_message persistEvent failed",
      );
    }
    try {
      await this.broadcaster.emitEventEnvelope(task.agentSessionId, event as SSEEventPayload);
    } catch (err) {
      this.logger.warn(
        { err, sessionId: task.agentSessionId },
        "user_message broadcast failed",
      );
    }
    try {
      await this.persistence.handleSideEffects(
        task.agentSessionId,
        event as SSEEventPayload,
        task,
      );
    } catch (err) {
      this.logger.warn(
        { err, sessionId: task.agentSessionId },
        "user_message handleSideEffects failed",
      );
    }
  }

  /**
   * 종료 처리: DB sessions 업데이트 + session_updated broadcast + engine.close.
   */
  private async _finalize(task: Task): Promise<void> {
    const finalStatus = task.status;

    // DB sessions 갱신
    try {
      await this.db.updateSession(task.agentSessionId, {
        status: finalStatus,
        last_event_id: task.lastEventId,
      });
    } catch (err) {
      this.logger.warn(
        { err, sessionId: task.agentSessionId },
        "DB updateSession failed in finalize",
      );
    }

    // broadcast
    try {
      await this.broadcaster.emitSessionUpdated(task);
    } catch (err) {
      this.logger.warn(
        { err, sessionId: task.agentSessionId },
        "session_updated broadcast failed",
      );
    }

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
  }
}

/** 외부 검증용 — task가 종료 상태인지. */
export function isTerminalStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "error" || status === "interrupted";
}
