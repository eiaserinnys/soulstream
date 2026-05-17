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

    const promise = this._consumeEventStream(task, engine).catch(
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

  private async _consumeEventStream(
    task: Task,
    engine: EnginePort,
  ): Promise<void> {
    try {
      for await (const event of engine.execute({ prompt: task.prompt, model: task.model })) {
        await this._processEvent(task, event);
      }
      // generator가 정상 종료 — 별도 error/interrupted 신호 없으면 completed
      if (task.status === "running") {
        task.status = "completed";
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
    try {
      await this.broadcaster.emitEventEnvelope(task.agentSessionId, event);
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
