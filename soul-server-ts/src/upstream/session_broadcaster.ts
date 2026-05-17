/**
 * SessionBroadcaster — orch에 wire 발행 (Phase B-3).
 *
 * Python `service/session_broadcaster.py` L67-108 정본과 *wire payload 키 일치*.
 * spec-quality-gate §10 "세션 직렬화 wire 키 동시 갱신"의 TS 자리.
 *
 * Codex 단일턴 모델 — Python `emit_session_phase` (멀티턴 idle 전환)는 *불필요*.
 * B-4 multi-turn 지원 시 추가 검토.
 *
 * 본 PR 범위 외:
 *   - emit_session_message_updated (text_delta마다 last_message wire 발행) → 후속 카드
 */

import type { AgentRegistry } from "../agent_registry.js";
import type { SSEEventPayload } from "../engine/protocol.js";
import type { Task } from "../task/task_models.js";

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
