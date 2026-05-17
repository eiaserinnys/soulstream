/**
 * SessionBroadcaster — orch에 wire 발행 (Phase B-3 + F-3A 후속 사이클).
 *
 * Python `service/session_broadcaster.py` L52-221 정본과 *wire payload 키 일치*.
 * spec-quality-gate §10 "세션 직렬화 wire 키 동시 갱신"의 TS 자리.
 *
 * Codex 단일턴 모델 — Python `emit_session_phase` (멀티턴 idle 전환)는 *불필요*.
 * B-4 multi-turn 지원 시 추가 검토.
 */

import type { AgentRegistry } from "../agent_registry.js";
import type { LastMessageRow } from "../db/session_db.js";
import type { SSEEventPayload } from "../engine/protocol.js";
import type { InterventionMessage, Task, TaskStatus } from "../task/task_models.js";

import type { SendFn } from "./dispatcher.js";

export class SessionBroadcaster {
  constructor(
    private readonly send: SendFn,
    private readonly agentRegistry: AgentRegistry,
    private readonly nodeId: string,
  ) {}

  /**
   * 세션 생성 wire. Python `emit_session_created` L67-77 정본:
   *   {type, session, folder_id, caller_source}
   */
  async emitSessionCreated(
    task: Task,
    folderId: string | null,
  ): Promise<void> {
    await this.send({
      type: "session_created",
      session: this.toSessionInfo(task),
      folder_id: folderId,
      caller_source: task.callerInfo?.source ?? null,
    });
  }

  /**
   * 세션 상태 변경 wire. Python `emit_session_updated` L88-108 정본:
   *   {type, agent_session_id, status, updated_at, last_event_id, last_read_event_id,
   *    last_progress_text, last_assistant_text, session_type,
   *    caller_source, userName, userPortraitUrl}
   *
   * 본 PR (Codex 단일턴): session_type 항상 "claude" (sessions.session_type 컬럼 기본값 정합).
   */
  async emitSessionUpdated(task: Task): Promise<void> {
    const updatedAt = task.completedAt ?? new Date();
    const callerInfo = task.callerInfo ?? {};
    await this.send({
      type: "session_updated",
      agent_session_id: task.agentSessionId,
      status: task.status,
      updated_at: updatedAt.toISOString(),
      last_event_id: task.lastEventId,
      last_read_event_id: task.lastReadEventId,
      last_progress_text: task.lastProgressText ?? null,
      last_assistant_text: task.lastAssistantText ?? null,
      session_type: "claude",
      caller_source: typeof callerInfo.source === "string" ? callerInfo.source : null,
      userName:
        typeof callerInfo.display_name === "string" ? callerInfo.display_name : null,
      userPortraitUrl:
        typeof callerInfo.avatar_url === "string" ? callerInfo.avatar_url : null,
    });
  }

  /**
   * 세션 last_message 갱신 wire (F-3A). Python `emit_session_message_updated` L141-221 정본:
   *   {type: "session_updated", agent_session_id, status, updated_at, last_message,
   *    last_event_id, last_read_event_id}
   *
   * **payload 키 7종** — emit_session_updated/phase와 *type* 키는 공유하지만 다음으로 구분:
   *   - G-19 식별 마커: 본 wire는 `last_message` 키를 *반드시* 포함 (orch가 wire 종류 식별에 사용)
   *   - P6 결정: caller_source/userName/userPortraitUrl 키 *비움* (atom `d7a1ad86` 정본 둘 안티패턴 회피)
   *
   * emit_session_updated/phase에 last_message 키를 *추가하지 말 것* — 식별 마커 충돌로 G-19 회로 재발.
   *
   * 참조:
   *   - Python L172-201 G-19 fix 주석 ("변경 금지 사항" 3건)
   *   - atom `b558ca3b` wire payload 키 정본
   *   - atom `d7a1ad86` 정본 둘 안티패턴
   */
  async emitSessionMessageUpdated(
    agentSessionId: string,
    status: TaskStatus,
    updatedAt: string,
    lastMessage: LastMessageRow,
    lastEventId: number,
    lastReadEventId: number,
  ): Promise<void> {
    await this.send({
      type: "session_updated",
      agent_session_id: agentSessionId,
      status,
      updated_at: updatedAt,
      last_message: lastMessage,
      last_event_id: lastEventId,
      last_read_event_id: lastReadEventId,
    });
  }

  /**
   * 세션 삭제 wire. Python `BaseSessionBroadcaster.emit_session_deleted` 정본:
   *   {type, agent_session_id}
   */
  async emitSessionDeleted(agentSessionId: string): Promise<void> {
    await this.send({
      type: "session_deleted",
      agent_session_id: agentSessionId,
    });
  }

  /**
   * Catalog 갱신 wire (Python `task_manager.py:312-316` 정본):
   *   {type: "catalog_updated", catalog: {folders, sessions}}
   *
   * 새 세션이 폴더에 배정된 직후 호출하여 dashboard 폴더 트리·세션 목록이 즉시 갱신되게 한다.
   * orch가 catalog_updated wire를 받아 dashboard SSE에 forward.
   */
  async emitCatalogUpdated(catalog: unknown): Promise<void> {
    await this.send({
      type: "catalog_updated",
      catalog,
    });
  }

  /**
   * SSE 이벤트 envelope wire. Python `event_relay.py` L175-179 정본:
   *   {type: "event", agentSessionId, event: SSEEventPayload}
   *
   * agentSessionId는 *camelCase* — wire-schema `SessionEventEnvelope.agentSessionId`.
   */
  async emitEventEnvelope(
    agentSessionId: string,
    event: SSEEventPayload,
  ): Promise<void> {
    await this.send({
      type: "event",
      agentSessionId,
      event,
    });
  }

  /**
   * Intervention 메시지가 turn 사이 큐잉 또는 auto-resume 트리거 시 발행.
   *
   * Python `task_executor.py:352-389 on_intervention_sent` 정본 패턴. wire envelope는
   * `emitEventEnvelope`와 동일하게 `{type:"event", agentSessionId, event:{...}}` 형식 —
   * orch `_on_event`가 subscribe_listeners에 broadcast하여 dashboard·다른 클라이언트가
   * 실시간 표시 가능. event 본문은 `{type:"intervention_sent", user, text, caller_info?,
   * attachments?, timestamp}` (Python `models/schemas.py InterventionSentEvent` 정본).
   */
  async emitInterventionSent(
    agentSessionId: string,
    message: InterventionMessage,
  ): Promise<void> {
    const event: Record<string, unknown> = {
      type: "intervention_sent",
      user: message.user,
      text: message.text,
      timestamp: Date.now() / 1000,
    };
    if (message.callerInfo) {
      event.caller_info = message.callerInfo;
    }
    if (message.attachmentPaths && message.attachmentPaths.length > 0) {
      event.attachments = message.attachmentPaths;
    }
    await this.send({
      type: "event",
      agentSessionId,
      event,
    });
  }

  /**
   * Task → session info dict. Python `task_models.py::to_session_info` 정본 키.
   *
   * 사용처: emit_session_created.session 필드 + (후속) session_list 응답.
   */
  private toSessionInfo(task: Task): Record<string, unknown> {
    const updatedAt = task.completedAt ?? task.createdAt;
    const info: Record<string, unknown> = {
      agent_session_id: task.agentSessionId,
      status: task.status,
      prompt: task.prompt,
      created_at: task.createdAt.toISOString(),
      updated_at: updatedAt.toISOString(),
      pid: null,  // Codex SDK는 별도 process가 SDK 내부에 — TS에서 pid 노출 안 함
      session_type: "claude",
      caller_session_id: task.callerSessionId ?? null,
      metadata: [],
      last_event_id: task.lastEventId,
      last_read_event_id: task.lastReadEventId,
      node_id: this.nodeId,
    };

    if (task.profileId) {
      const agent = this.agentRegistry.get(task.profileId);
      info.agentId = task.profileId;
      info.agentName = agent?.name ?? null;
      info.agentPortraitUrl =
        agent?.portrait_path ? `/api/agents/${agent.id}/portrait` : null;
      info.backend = agent?.backend ?? null;
    }

    const callerInfo = task.callerInfo ?? {};
    if (typeof callerInfo.display_name === "string" && callerInfo.display_name) {
      info.userName = callerInfo.display_name;
    }
    if (typeof callerInfo.avatar_url === "string" && callerInfo.avatar_url) {
      info.userPortraitUrl = callerInfo.avatar_url;
    }

    return info;
  }
}
