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
import type { SSEEventPayload } from "../engine/protocol.js";
import type { Task } from "../task/task_models.js";
import { effectiveTaskBackend } from "../task/task_model_preset.js";
import type {
  CatalogBoardItemsDelta,
  CatalogFolderRecord,
  CatalogSessionsDelta,
} from "../catalog/catalog_delta.js";

import type { SendFn } from "./dispatcher.js";

export class SessionBroadcaster {
  constructor(
    private readonly send: SendFn,
    private readonly agentRegistry: AgentRegistry,
    private readonly nodeId: string,
  ) {}

  /**
   * 세션 생성 wire. Python `emit_session_created` L67-77 정본:
   *   {type, session, folder_id, folderId, caller_source}
   */
  async emitSessionCreated(
    task: Task,
    folderId: string | null,
  ): Promise<void> {
    const session = this.toSessionInfo(task);
    session.folder_id = folderId;
    session.folderId = folderId;
    await this.send({
      type: "session_created",
      session,
      folder_id: folderId,
      folderId,
      caller_source: task.callerInfo?.source ?? null,
    });
  }

  /**
   * 세션 상태 변경 wire. last_event_id는 event ingress만 갱신하므로 제외한다:
   *   {type, agent_session_id, status, updated_at, last_read_event_id,
   *    last_progress_text, last_assistant_text, session_type,
   *    caller_source, userName, userPortraitUrl}
   *
   * agent 세션은 "claude", LLM proxy 세션은 "llm".
   */
  async emitSessionUpdated(task: Task): Promise<void> {
    const updatedAt = task.completedAt ?? new Date();
    const callerInfo = task.callerInfo ?? {};
    const sessionType = task.sessionType ?? "claude";
    await this.send({
      type: "session_updated",
      agent_session_id: task.agentSessionId,
      status: task.status,
      updated_at: updatedAt.toISOString(),
      last_read_event_id: task.lastReadEventId,
      last_progress_text: task.lastProgressText ?? null,
      last_assistant_text: task.lastAssistantText ?? null,
      session_type: sessionType,
      caller_source: typeof callerInfo.source === "string" ? callerInfo.source : null,
      userName:
        typeof callerInfo.display_name === "string" ? callerInfo.display_name : null,
      userPortraitUrl:
        typeof callerInfo.avatar_url === "string" ? callerInfo.avatar_url : null,
      termination_reason: task.terminationReason ?? null,
      terminationReason: task.terminationReason ?? null,
      termination_detail: task.terminationDetail ?? null,
      terminationDetail: task.terminationDetail ?? null,
      review_required: task.reviewRequired === true,
      review_state: task.reviewState ?? "not_required",
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

  /** Catalog 변경분 wire. 두 delta 키는 빈 객체일 때도 항상 존재한다. */
  async emitCatalogUpdated(
    folders: readonly CatalogFolderRecord[],
    sessionsDelta: CatalogSessionsDelta,
    boardItemsDelta: CatalogBoardItemsDelta,
  ): Promise<void> {
    await this.send({
      type: "catalog_updated",
      folders,
      sessions_delta: sessionsDelta,
      board_items_delta: boardItemsDelta,
    });
  }

  /**
   * Task mutation 갱신 wire.
   *
   * SessionEventEnvelope 경로를 사용한다. 업무은 board item에 붙은 공유 상태지만,
   * MCP mutation의 actor session을 envelope owner로 삼아 기존 orch subscribe_events
   * 릴레이를 그대로 탄다.
   */
  async emitTaskUpdated(
    agentSessionId: string,
    taskId: string,
    boardItemId: string,
  ): Promise<void> {
    await this.emitEventEnvelope(agentSessionId, {
      type: "task_updated",
      taskId,
      boardItemId,
    });
  }

  async emitCustomViewUpdated(
    agentSessionId: string,
    customViewId: string,
    boardItemId: string,
    revision: number,
  ): Promise<void> {
    await this.emitEventEnvelope(agentSessionId, {
      type: "custom_view_updated",
      customViewId,
      boardItemId,
      revision,
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
    const sessionType = task.sessionType ?? "claude";
    const info: Record<string, unknown> = {
      agent_session_id: task.agentSessionId,
      status: task.status,
      prompt: task.prompt,
      created_at: task.createdAt.toISOString(),
      updated_at: updatedAt.toISOString(),
      pid: null,  // Codex SDK는 별도 process가 SDK 내부에 — TS에서 pid 노출 안 함
      session_type: sessionType,
      caller_session_id: task.callerSessionId ?? null,
      metadata: task.metadata ?? [],
      last_event_id: task.lastEventId,
      last_read_event_id: task.lastReadEventId,
      node_id: this.nodeId,
      termination_reason: task.terminationReason ?? null,
      terminationReason: task.terminationReason ?? null,
      termination_detail: task.terminationDetail ?? null,
      terminationDetail: task.terminationDetail ?? null,
      review_required: task.reviewRequired === true,
      review_state: task.reviewState ?? "not_required",
      binding_warnings: task.creationWarnings ?? [],
      model_preset: task.modelPreset ?? null,
      model: task.model ?? null,
    };
    if (sessionType !== "claude") {
      info.llm_provider = task.llmProvider ?? null;
      info.llm_model = task.llmModel ?? null;
      info.llm_usage = task.llmUsage ?? null;
      info.client_id = task.clientId ?? null;
    }

    // Phase A backend 정본 단일화 (atom d7a1ad86 정본 둘 안티패턴 차단):
    // - profileId 부재 task도 wire에 backend default "claude"를 박아 FE 조건
    //   `{session.backend && ...}` silent drop 차단. agentId/Name/PortraitUrl은 null로 박음.
    // - default "claude"는 Python `_session_to_response` (session_serializer.py:131)와 같은 정책.
    if (task.profileId) {
      const agent = task.agentProfileSnapshot ?? this.agentRegistry.get(task.profileId);
      info.agentId = agent?.id ?? task.profileId;
      info.agentName = agent?.name ?? null;
      info.agentPortraitUrl = task.agentProfileHasDbPortrait
        ? `/api/nodes/${this.nodeId}/agents/${agent?.id ?? task.profileId}/portrait`
        : agent?.portrait_path
          ? `/api/agents/${agent.id}/portrait`
          : null;
      info.backend = agent ? effectiveTaskBackend(task, agent) : "claude";
    } else if (sessionType === "claude") {
      info.agentId = null;
      info.agentName = null;
      info.agentPortraitUrl = null;
      info.backend = "claude";
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
