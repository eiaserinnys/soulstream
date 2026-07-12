/* AUTO-GENERATED — do not edit. Run packages/wire-schema/scripts/generate.sh */

/**
 * 노드 ↔ 오케스트레이터 WebSocket 메시지 정본. 108개 $defs (wire 51 + SSE event 57). 출처: soul-server-ts/src/upstream/* · packages/wire-schema generated SSE types + OpenAI Agents SDK parity.
 */
export type SoulstreamUpstreamProtocol =
  | NodeRegister
  | AppHeartbeatPing
  | AppHeartbeatPong
  | SessionCreated
  | SessionEventEnvelope
  | SessionsUpdate
  | HealthStatus
  | SessionUpdated
  | SessionDeleted
  | ErrorMessage
  | InterveneAck
  | InterruptSessionAck
  | AcknowledgeSessionReviewAck
  | RespondAck
  | ToolApprovalAck
  | RealtimeCallCreated
  | RealtimeEventAck
  | RealtimeToolApprovalAck
  | UploadAttachmentResult
  | UploadAttachmentStartAck
  | UploadAttachmentChunkAck
  | UploadAttachmentAbortAck
  | DeleteSessionAttachmentsResult
  | DownloadAttachmentResult
  | CreateSession
  | Intervene
  | InterruptSession
  | AcknowledgeSessionReview
  | Respond
  | ApproveTool
  | RejectTool
  | RealtimeCreateCall
  | RealtimeEvent
  | RealtimeResolveToolApproval
  | ListSessions
  | UploadAttachment
  | UploadAttachmentStart
  | UploadAttachmentChunk
  | UploadAttachmentFinish
  | UploadAttachmentAbort
  | DeleteSessionAttachments
  | DownloadAttachment
  | PlanAgentProfileUpdate
  | ApplyAgentProfileUpdate
  | ListAgentsConfigSnapshots
  | RollbackAgentsConfig
  | HealthCheck
  | SubscribeEvents
  | ClaudeAuthStatus
  | ClaudeAuthSetToken
  | ClaudeAuthDeleteToken
  | ClaudeAuthGetUsage
  | ClaudeAuthGetProfile;

/**
 * 노드→orch: 등록. soul-server-ts/src/upstream/registration.ts.
 */
export interface NodeRegister {
  type: "node_register";
  node_id: string;
  host?: string;
  port?: number;
  /**
   * 노드 자체 가용성 정보. 예: {max_concurrent: 5, app_heartbeat_v1: true}
   */
  capabilities?: {
    [k: string]: unknown;
  };
  /**
   * 이 노드가 지원하는 백엔드 식별자. 옵션 D — Codex/Claude 라우팅 분기.
   */
  supported_backends?: string[];
  agents?: {
    id?: string;
    name?: string;
    backend?: string;
    portrait_url?: string;
    max_turns?: number | null;
    portrait_b64?: string;
    [k: string]: unknown;
  }[];
  /**
   * 선택. 노드 사용자 프로필 (name, hasPortrait, portrait_b64).
   */
  user?: {
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
/**
 * 양방향 app-level heartbeat ping. requestId 없는 liveness 전용 메시지.
 */
export interface AppHeartbeatPing {
  type: "app_heartbeat_ping";
  /**
   * 디버깅/echo용 ISO timestamp. 수신자는 pong에 그대로 반사한다.
   */
  sentAt?: string;
  [k: string]: unknown;
}
/**
 * 양방향 app-level heartbeat pong. business command pending과 분리된 liveness 응답.
 */
export interface AppHeartbeatPong {
  type: "app_heartbeat_pong";
  /**
   * ping에서 받은 sentAt echo.
   */
  sentAt?: string;
  [k: string]: unknown;
}
/**
 * 노드→orch: 세션 생성 응답 또는 broadcast. soul-server-ts task creation and session broadcaster wire.
 */
export interface SessionCreated {
  type: "session_created";
  agentSessionId?: string;
  requestId?: string;
  /**
   * broadcast 경로에서 송신되는 세션 정보 (to_session_info 결과).
   */
  session?: {
    review_required?: boolean;
    review_state?: "not_required" | "needs_review" | "acknowledged";
    [k: string]: unknown;
  };
  folderId?: string | null;
  /**
   * agent caller_info 흐름 보존 (R-2 fix, atom 0499ee7b).
   */
  caller_source?: {
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
/**
 * 노드→orch: SSE 이벤트 wrapper. event.event 안에 SSEEvent* 중 하나가 packed.
 */
export interface SessionEventEnvelope {
  type: "event";
  agentSessionId: string;
  /**
   * 구버전 호환 — 신규 코드는 agentSessionId 사용.
   */
  session_id?: string;
  /**
   * SSE event payload. orch-server KNOWN_SSE_EVENT_TYPES 중 하나.
   */
  event:
    | SSEEventInit
    | SSEEventReconnected
    | SSEEventProgress
    | SSEEventMemory
    | SSEEventSession
    | SSEEventInterventionSent
    | SSEEventUserMessage
    | SSEEventAssistantMessage
    | SSEEventInputRequest
    | SSEEventInputRequestExpired
    | SSEEventInputRequestResponded
    | SSEEventDebug
    | SSEEventComplete
    | SSEEventError
    | SSEEventCredentialAlert
    | SSEEventSessionEnded
    | SSEEventThinking
    | SSEEventTextStart
    | SSEEventTextDelta
    | SSEEventTextEnd
    | SSEEventToolStart
    | SSEEventToolResult
    | SSEEventAgentUpdated
    | SSEEventHandoffRequested
    | SSEEventHandoffOccurred
    | SSEEventToolApprovalRequested
    | SSEEventToolApprovalResolved
    | SSEEventGuardrailTripwire
    | SSEEventRealtimeStatus
    | SSEEventRealtimeTranscript
    | SSEEventResult
    | SSEEventPromptSuggestion
    | SSEEventSubagentStart
    | SSEEventSubagentStop
    | SSEEventClaudeRuntimeSessionState
    | SSEEventClaudeRuntimeTaskStarted
    | SSEEventClaudeRuntimeTaskCreated
    | SSEEventClaudeRuntimeTaskUpdated
    | SSEEventClaudeRuntimeTaskProgress
    | SSEEventClaudeRuntimeTaskCompleted
    | SSEEventClaudeRuntimeTaskNotification
    | SSEEventClaudeRuntimeNotification
    | SSEEventClaudeRuntimeRemoteTrigger
    | SSEEventClaudeRuntimeTranscriptMirrorError
    | SSEEventClaudeRuntimeHookEvent
    | SSEEventClaudeRuntimeModeState
    | SSEEventClaudeRuntimeScheduleUpdated
    | SSEEventClaudeRuntimeScheduleDeleted
    | SSEEventRunbookUpdated
    | SSEEventCustomViewUpdated
    | SSEEventContextUsage
    | SSEEventCompact
    | SSEEventReconnect
    | SSEEventHistorySync
    | SSEEventMetadataUpdated
    | SSEEventAssistantError
    | SSEEventAwaySummary;
  [k: string]: unknown;
}
/**
 * SSE: 세션 스트림 초기화. event 메시지의 event 키 안에 packed.
 */
export interface SSEEventInit {
  type: "init";
  [k: string]: unknown;
}
/**
 * SSE: 재연결 안내.
 */
export interface SSEEventReconnected {
  type: "reconnected";
  [k: string]: unknown;
}
/**
 * SSE: 진행 상태.
 */
export interface SSEEventProgress {
  type: "progress";
  [k: string]: unknown;
}
/**
 * SSE: memory 이벤트.
 */
export interface SSEEventMemory {
  type: "memory";
  [k: string]: unknown;
}
/**
 * SSE: 세션 메타.
 */
export interface SSEEventSession {
  type: "session";
  [k: string]: unknown;
}
/**
 * SSE: 사용자 개입 메시지 발신.
 */
export interface SSEEventInterventionSent {
  type: "intervention_sent";
  [k: string]: unknown;
}
/**
 * SSE: 사용자 메시지.
 */
export interface SSEEventUserMessage {
  type: "user_message";
  [k: string]: unknown;
}
/**
 * SSE: 어시스턴트 메시지 완료본.
 */
export interface SSEEventAssistantMessage {
  type: "assistant_message";
  [k: string]: unknown;
}
/**
 * SSE: AskUserQuestion 요청. 별도 wire 메시지로도 forwarding.
 */
export interface SSEEventInputRequest {
  type: "input_request";
  [k: string]: unknown;
}
/**
 * SSE: input_request 만료.
 */
export interface SSEEventInputRequestExpired {
  type: "input_request_expired";
  [k: string]: unknown;
}
/**
 * SSE: input_request 응답 도착.
 */
export interface SSEEventInputRequestResponded {
  type: "input_request_responded";
  [k: string]: unknown;
}
/**
 * SSE: debug 로그.
 */
export interface SSEEventDebug {
  type: "debug";
  [k: string]: unknown;
}
/**
 * SSE: 턴 종료.
 */
export interface SSEEventComplete {
  type: "complete";
  [k: string]: unknown;
}
/**
 * SSE: 에러.
 */
export interface SSEEventError {
  type: "error";
  [k: string]: unknown;
}
/**
 * SSE: Claude credential/rate-limit alert.
 */
export interface SSEEventCredentialAlert {
  type: "credential_alert";
  [k: string]: unknown;
}
/**
 * SSE: 세션 종료 사유 확정 이벤트.
 */
export interface SSEEventSessionEnded {
  type: "session_ended";
  status: string;
  termination_reason: "completed_ok" | "killed" | "limit_hit" | "error_aborted" | "unknown";
  termination_detail?: string | null;
  timestamp?: number;
  [k: string]: unknown;
}
/**
 * SSE: thinking 블록.
 */
export interface SSEEventThinking {
  type: "thinking";
  [k: string]: unknown;
}
/**
 * SSE: text 블록 시작.
 */
export interface SSEEventTextStart {
  type: "text_start";
  [k: string]: unknown;
}
/**
 * SSE: text delta.
 */
export interface SSEEventTextDelta {
  type: "text_delta";
  [k: string]: unknown;
}
/**
 * SSE: text 블록 종료.
 */
export interface SSEEventTextEnd {
  type: "text_end";
  [k: string]: unknown;
}
/**
 * SSE: tool 호출 시작.
 */
export interface SSEEventToolStart {
  type: "tool_start";
  [k: string]: unknown;
}
/**
 * SSE: tool 호출 결과.
 */
export interface SSEEventToolResult {
  type: "tool_result";
  [k: string]: unknown;
}
/**
 * SSE: OpenAI Agents SDK active agent 변경.
 */
export interface SSEEventAgentUpdated {
  type: "agent_updated";
  [k: string]: unknown;
}
/**
 * SSE: OpenAI Agents SDK handoff 요청.
 */
export interface SSEEventHandoffRequested {
  type: "handoff_requested";
  [k: string]: unknown;
}
/**
 * SSE: OpenAI Agents SDK handoff 완료.
 */
export interface SSEEventHandoffOccurred {
  type: "handoff_occurred";
  [k: string]: unknown;
}
/**
 * SSE: OpenAI Agents SDK tool approval 요청.
 */
export interface SSEEventToolApprovalRequested {
  type: "tool_approval_requested";
  [k: string]: unknown;
}
/**
 * SSE: OpenAI Agents SDK tool approval 승인/거부 완료.
 */
export interface SSEEventToolApprovalResolved {
  type: "tool_approval_resolved";
  [k: string]: unknown;
}
/**
 * SSE: OpenAI Agents SDK guardrail tripwire로 run 중단.
 */
export interface SSEEventGuardrailTripwire {
  type: "guardrail_tripwire";
  [k: string]: unknown;
}
/**
 * SSE: soul-app Realtime voice connection/listening/responding/idle status.
 */
export interface SSEEventRealtimeStatus {
  type: "realtime_status";
  status: string;
  call_id?: string;
  message?: string;
  timestamp?: number;
  raw_event_type?: string;
  [k: string]: unknown;
}
/**
 * SSE: soul-app Realtime voice final user/assistant transcript.
 */
export interface SSEEventRealtimeTranscript {
  type: "realtime_transcript";
  role: "user" | "assistant";
  text: string;
  final?: boolean;
  call_id?: string;
  item_id?: string;
  timestamp?: number;
  raw_event_type?: string;
  [k: string]: unknown;
}
/**
 * SSE: 최종 result.
 */
export interface SSEEventResult {
  type: "result";
  [k: string]: unknown;
}
/**
 * SSE: Claude prompt suggestion.
 */
export interface SSEEventPromptSuggestion {
  type: "prompt_suggestion";
  [k: string]: unknown;
}
/**
 * SSE: subagent 시작.
 */
export interface SSEEventSubagentStart {
  type: "subagent_start";
  [k: string]: unknown;
}
/**
 * SSE: subagent 종료.
 */
export interface SSEEventSubagentStop {
  type: "subagent_stop";
  [k: string]: unknown;
}
/**
 * SSE: Claude Agent SDK session runtime 상태. idle은 background-agent loop 종료 후 authoritative turn-over signal.
 */
export interface SSEEventClaudeRuntimeSessionState {
  type: "claude_runtime_session_state";
  state: "idle" | "running" | "requires_action";
  session_id?: string;
  timestamp?: number;
  [k: string]: unknown;
}
/**
 * SSE: Claude Agent SDK background/runtime task 시작.
 */
export interface SSEEventClaudeRuntimeTaskStarted {
  type: "claude_runtime_task_started";
  task_id: string;
  session_id?: string;
  tool_use_id?: string;
  description?: string;
  task_type?: string;
  workflow_name?: string;
  prompt?: string;
  skip_transcript?: boolean;
  timestamp?: number;
  [k: string]: unknown;
}
/**
 * SSE: Claude Agent SDK TaskCreated hook lifecycle. Soulstream Task Tree와 별도 개념.
 */
export interface SSEEventClaudeRuntimeTaskCreated {
  type: "claude_runtime_task_created";
  task_id: string;
  session_id?: string;
  subject: string;
  description?: string;
  teammate_name?: string;
  team_name?: string;
  timestamp?: number;
  [k: string]: unknown;
}
/**
 * SSE: Claude Agent SDK runtime task 상태 patch.
 */
export interface SSEEventClaudeRuntimeTaskUpdated {
  type: "claude_runtime_task_updated";
  task_id: string;
  session_id?: string;
  patch: {
    status?: "pending" | "running" | "completed" | "failed" | "stopped" | "killed";
    description?: string;
    end_time?: number;
    total_paused_ms?: number;
    error?: string;
    is_backgrounded?: boolean;
    [k: string]: unknown;
  };
  timestamp?: number;
  [k: string]: unknown;
}
/**
 * SSE: Claude Agent SDK runtime task 진행 상태.
 */
export interface SSEEventClaudeRuntimeTaskProgress {
  type: "claude_runtime_task_progress";
  task_id: string;
  session_id?: string;
  tool_use_id?: string;
  description?: string;
  usage?: {
    [k: string]: unknown;
  };
  last_tool_name?: string;
  summary?: string;
  timestamp?: number;
  [k: string]: unknown;
}
/**
 * SSE: Claude Agent SDK TaskCompleted hook lifecycle. Soulstream Task Tree와 별도 개념.
 */
export interface SSEEventClaudeRuntimeTaskCompleted {
  type: "claude_runtime_task_completed";
  task_id: string;
  session_id?: string;
  subject: string;
  description?: string;
  teammate_name?: string;
  team_name?: string;
  timestamp?: number;
  [k: string]: unknown;
}
/**
 * SSE: Claude Agent SDK runtime task terminal notification. 기존 subagent_stop과 병행 발행.
 */
export interface SSEEventClaudeRuntimeTaskNotification {
  type: "claude_runtime_task_notification";
  task_id: string;
  status: "completed" | "failed" | "stopped";
  session_id?: string;
  tool_use_id?: string;
  output_file?: string;
  summary?: string;
  usage?: {
    [k: string]: unknown;
  };
  skip_transcript?: boolean;
  timestamp?: number;
  [k: string]: unknown;
}
/**
 * SSE: Claude Agent SDK Notification/PushNotification을 Soulstream in-app 알림으로 노출. 외부 APNs/Expo 발송은 포함하지 않는다.
 */
export interface SSEEventClaudeRuntimeNotification {
  type: "claude_runtime_notification";
  notification_id: string;
  source: "hook" | "system" | "tool_use";
  message: string;
  title?: string;
  notification_type?: string;
  key?: string;
  priority?: string;
  session_id?: string;
  tool_use_id?: string;
  timestamp?: number;
  [k: string]: unknown;
}
/**
 * SSE: Claude Agent SDK RemoteTrigger/tool 또는 remote-origin user message를 기존 intervention/capability 표면에 맞춘 runtime 관찰 이벤트로 노출.
 */
export interface SSEEventClaudeRuntimeRemoteTrigger {
  type: "claude_runtime_remote_trigger";
  trigger_id: string;
  source: "message_origin" | "tool_use";
  session_id?: string;
  tool_use_id?: string;
  origin_kind?: string;
  origin_from?: string;
  origin_name?: string;
  origin_server?: string;
  priority?: string;
  prompt?: string;
  trigger_type?: string;
  payload?: {
    [k: string]: unknown;
  };
  timestamp?: number;
  [k: string]: unknown;
}
/**
 * SSE: Claude Agent SDK SessionStore mirror_error. transcript mirror 손실을 조용히 삼키지 않고 runtime 표면에 남긴다.
 */
export interface SSEEventClaudeRuntimeTranscriptMirrorError {
  type: "claude_runtime_transcript_mirror_error";
  mirror_id: string;
  session_id?: string;
  project_key: string;
  transcript_session_id: string;
  subpath?: string;
  error: string;
  timestamp?: number;
  [k: string]: unknown;
}
/**
 * SSE: Claude Agent SDK generic hook lifecycle payload preservation.
 */
export interface SSEEventClaudeRuntimeHookEvent {
  type: "claude_runtime_hook_event";
  hook_event_name: string;
  session_id?: string;
  tool_name?: string;
  tool_use_id?: string;
  hook_input?: {
    [k: string]: unknown;
  };
  timestamp?: number;
  [k: string]: unknown;
}
/**
 * SSE: Claude Agent SDK plan/worktree mode state.
 */
export interface SSEEventClaudeRuntimeModeState {
  type: "claude_runtime_mode_state";
  mode: "plan" | "worktree";
  active: boolean;
  source: "hook" | "tool_use";
  session_id?: string;
  tool_name?: string;
  tool_use_id?: string;
  worktree_name?: string;
  worktree_path?: string;
  worktree_action?: string;
  timestamp?: number;
  [k: string]: unknown;
}
/**
 * SSE: Soulstream durable schedule 상태 변경.
 */
export interface SSEEventClaudeRuntimeScheduleUpdated {
  type: "claude_runtime_schedule_updated";
  schedule_id: string;
  session_id?: string;
  schedule_kind: "wakeup" | "cron";
  status: "active" | "dispatching" | "firing" | "completed" | "cancelled" | "failed" | "orphaned";
  prompt?: string;
  source_tool?: string;
  tool_use_id?: string | null;
  cron_expression?: string | null;
  run_once_at?: string | null;
  timezone?: string;
  recurring?: boolean;
  next_run_at?: string | null;
  last_fired_at?: string | null;
  fired_count?: number;
  last_error?: string | null;
  created_at?: string;
  updated_at?: string;
  timestamp?: number;
  [k: string]: unknown;
}
/**
 * SSE: Soulstream durable schedule 삭제/취소.
 */
export interface SSEEventClaudeRuntimeScheduleDeleted {
  type: "claude_runtime_schedule_deleted";
  schedule_id: string;
  session_id?: string;
  status: "active" | "dispatching" | "firing" | "completed" | "cancelled" | "failed" | "orphaned";
  updated_at?: string;
  timestamp?: number;
  [k: string]: unknown;
}
/**
 * SSE: 런북 mutation 후 뷰 갱신 트리거.
 */
export interface SSEEventRunbookUpdated {
  type: "runbook_updated";
  runbookId: string;
  boardItemId: string;
  [k: string]: unknown;
}
/**
 * SSE: 커스텀 뷰 mutation 후 뷰 갱신 트리거. HTML 본문은 wire에 싣지 않는다.
 */
export interface SSEEventCustomViewUpdated {
  type: "custom_view_updated";
  customViewId: string;
  boardItemId: string;
  revision: number;
  [k: string]: unknown;
}
/**
 * SSE: 컨텍스트 사용량.
 */
export interface SSEEventContextUsage {
  type: "context_usage";
  [k: string]: unknown;
}
/**
 * SSE: compact 안내.
 */
export interface SSEEventCompact {
  type: "compact";
  [k: string]: unknown;
}
/**
 * SSE: 클라이언트에 재연결 권고.
 */
export interface SSEEventReconnect {
  type: "reconnect";
  [k: string]: unknown;
}
/**
 * SSE: 과거 이력 동기화.
 */
export interface SSEEventHistorySync {
  type: "history_sync";
  [k: string]: unknown;
}
/**
 * SSE: 세션 메타 갱신.
 */
export interface SSEEventMetadataUpdated {
  type: "metadata_updated";
  [k: string]: unknown;
}
/**
 * SSE: AssistantMessage.error 별 이벤트 — authentication_failed/billing_error/rate_limit 등 API 수준 에러를 dashboard가 분기 표시.
 */
export interface SSEEventAssistantError {
  type: "assistant_error";
  error_type: string;
  model?: string;
  message_id?: string;
  [k: string]: unknown;
}
/**
 * SSE: Claude CLI가 세션 복귀 시 발행하는 요약.
 */
export interface SSEEventAwaySummary {
  type: "away_summary";
  content: string;
  [k: string]: unknown;
}
/**
 * 노드→orch: 전체 세션 목록 dump. soul-server-ts/src/upstream/session_list_commands.ts.
 */
export interface SessionsUpdate {
  type: "sessions_update";
  sessions: {
    review_required?: boolean;
    review_state?: "not_required" | "needs_review" | "acknowledged";
    [k: string]: unknown;
  }[];
  total?: number;
  requestId?: string;
  [k: string]: unknown;
}
/**
 * 노드→orch: 헬스 응답. soul-server-ts/src/upstream/dispatcher.ts.
 */
export interface HealthStatus {
  type: "health_status";
  runners?: {
    [k: string]: unknown;
  };
  node_id?: string;
  requestId?: string;
  [k: string]: unknown;
}
/**
 * 노드→orch: 세션 상태 변경 broadcast. soul-server-ts/src/upstream/session_broadcaster.ts.
 */
export interface SessionUpdated {
  type: "session_updated";
  agent_session_id?: string;
  agentSessionId?: string;
  review_required?: boolean;
  review_state?: "not_required" | "needs_review" | "acknowledged";
  [k: string]: unknown;
}
/**
 * 노드→orch: 세션 삭제 broadcast. soul-server-ts/src/upstream/session_broadcaster.ts.
 */
export interface SessionDeleted {
  type: "session_deleted";
  agent_session_id?: string;
  agentSessionId?: string;
  [k: string]: unknown;
}
/**
 * 노드→orch: 에러 응답. soul-server-ts/src/upstream/dispatcher.ts.
 */
export interface ErrorMessage {
  type: "error";
  message: string;
  requestId?: string;
  /**
   * 구버전 snake_case 호환 필드.
   */
  request_id?: string;
  command_type?: string;
  [k: string]: unknown;
}
/**
 * 노드→orch: intervene 명령 ACK. soul-server-ts/src/task/task_intervention_route.ts. orch _send_command Future 매칭에 사용.
 */
export interface InterveneAck {
  type: "intervene_ack";
  requestId: string;
  status?: "ok";
  [k: string]: unknown;
}
/**
 * 노드→orch: interrupt_session 명령 ACK. soul-server-ts dispatcher.handleInterruptSession.
 */
export interface InterruptSessionAck {
  type: "interrupt_session_ack";
  requestId: string;
  status: "ok";
  interrupted?: boolean;
  agentSessionId?: string;
  [k: string]: unknown;
}
/**
 * 노드→orch: acknowledge_session_review 원자 전이 ACK.
 */
export interface AcknowledgeSessionReviewAck {
  type: "acknowledge_session_review_ack";
  requestId: string;
  status: "ok" | "error";
  agentSessionId: string;
  reviewState?: "acknowledged";
  changed?: boolean;
  code?: string;
  message?: string;
  [k: string]: unknown;
}
/**
 * 노드→orch: respond 명령 ACK. TS Claude AskUserQuestion 응답 전달 결과. 실패도 ACK로 반환하여 orch command timeout을 막는다.
 */
export interface RespondAck {
  type: "respond_ack";
  requestId: string;
  inputRequestId?: string;
  status: "ok" | "error";
  delivered?: boolean;
  eventId?: number;
  code?: string;
  message?: string;
  backend?: string;
  taskStatus?: string;
  [k: string]: unknown;
}
/**
 * 노드→orch: approve_tool/reject_tool ACK. OpenAI Agents SDK tool approval 결과. 실패도 ACK로 반환하여 orch command timeout을 막는다.
 */
export interface ToolApprovalAck {
  type: "tool_approval_ack";
  requestId: string;
  approvalId?: string;
  decision?: "approved" | "rejected";
  status: "ok" | "error";
  delivered?: boolean;
  eventId?: number;
  code?: string;
  message?: string;
  backend?: string;
  taskStatus?: string;
  [k: string]: unknown;
}
/**
 * 노드→orch: realtime_create_call ACK. soul-app WebRTC offer에 대한 OpenAI Realtime SDP answer.
 */
export interface RealtimeCallCreated {
  type: "realtime_call_created";
  requestId: string;
  agentSessionId?: string;
  status: "ok" | "error";
  callId?: string;
  answerSdp?: string;
  eventId?: number;
  code?: string;
  message?: string;
  [k: string]: unknown;
}
/**
 * 노드→orch: realtime_event ACK. soul-app data-channel event persistence/relay result.
 */
export interface RealtimeEventAck {
  type: "realtime_event_ack";
  requestId: string;
  agentSessionId?: string;
  status: "ok" | "error";
  normalizedType?: string;
  eventId?: number;
  code?: string;
  message?: string;
  [k: string]: unknown;
}
/**
 * 노드→orch: realtime_resolve_tool_approval ACK. Persisted resolution plus app data-channel decision event.
 */
export interface RealtimeToolApprovalAck {
  type: "realtime_tool_approval_ack";
  requestId: string;
  agentSessionId?: string;
  approvalId?: string;
  decision?: "approved" | "rejected";
  status: "ok" | "error";
  dataChannelEvent?: {
    [k: string]: unknown;
  };
  eventId?: number;
  code?: string;
  message?: string;
  [k: string]: unknown;
}
/**
 * 노드→orch: legacy upload_attachment 또는 chunked upload_attachment_finish 결과 ACK.
 */
export interface UploadAttachmentResult {
  type: "upload_attachment_result";
  requestId: string;
  path: string;
  filename: string;
  size: number;
  content_type: string;
  [k: string]: unknown;
}
/**
 * 노드→orch: upload_attachment_start ACK. 이후 chunk_index 0부터 전송한다.
 */
export interface UploadAttachmentStartAck {
  type: "upload_attachment_start_ack";
  requestId: string;
  upload_id: string;
  next_chunk_index: number;
  [k: string]: unknown;
}
/**
 * 노드→orch: upload_attachment_chunk ACK. 누적 size와 다음 chunk index를 반환한다.
 */
export interface UploadAttachmentChunkAck {
  type: "upload_attachment_chunk_ack";
  requestId: string;
  upload_id: string;
  chunk_index: number;
  next_chunk_index: number;
  size: number;
  [k: string]: unknown;
}
/**
 * 노드→orch: upload_attachment_abort ACK. temp upload cleanup 결과.
 */
export interface UploadAttachmentAbortAck {
  type: "upload_attachment_abort_ack";
  requestId: string;
  upload_id: string;
  aborted: boolean;
  [k: string]: unknown;
}
/**
 * 노드→orch: delete_session_attachments 결과 ACK.
 */
export interface DeleteSessionAttachmentsResult {
  type: "delete_session_attachments_result";
  requestId: string;
  cleaned: boolean;
  files_removed: number;
  [k: string]: unknown;
}
/**
 * 노드→orch: download_attachment 결과 ACK. 다운로드는 기존 single base64 payload 유지.
 */
export interface DownloadAttachmentResult {
  type: "download_attachment_result";
  requestId: string;
  content_b64: string;
  content_type: string;
  filename: string;
  size: number;
  [k: string]: unknown;
}
/**
 * orch→노드: 세션 생성 명령. soul-server-ts dispatcher create_session wire + 실측 caller_info 키.
 */
export interface CreateSession {
  type: "create_session";
  prompt: string;
  profile?: string;
  request_id?: string;
  requestId?: string;
  folderId?: string | null;
  allowed_tools?: string[];
  disallowed_tools?: string[];
  /**
   * Claude SDK permissionMode override. Missing preserves the node/profile default.
   */
  claude_permission_mode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";
  use_mcp?: boolean;
  context?: {
    [k: string]: unknown;
  };
  context_items?: {
    [k: string]: unknown;
  }[];
  extra_context_items?: {
    [k: string]: unknown;
  }[];
  caller_info?: {
    [k: string]: unknown;
  };
  /**
   * False suppresses caller completion relay for runbook-tracked fire-and-forget delegation. Missing defaults to true.
   */
  notify_completion?: boolean;
  attachment_paths?: string[];
  /**
   * Codex-only reasoning effort. Missing means codex adapter default xhigh.
   */
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  [k: string]: unknown;
}
/**
 * orch→노드: 개입 명령. attachment_paths/caller_info 포함.
 */
export interface Intervene {
  type: "intervene";
  agentSessionId: string;
  /**
   * 구버전 호환 — 신규 코드는 agentSessionId 사용.
   */
  session_id?: string;
  text: string;
  user?: string;
  requestId?: string;
  attachment_paths?: string[];
  /**
   * Supervisor/live intervention ride-along context items.
   */
  extra_context_items?: {
    [k: string]: unknown;
  }[];
  caller_info?: {
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
/**
 * orch→노드: 진행 중인 세션 turn 중단 명령.
 */
export interface InterruptSession {
  type: "interrupt_session";
  agentSessionId: string;
  /**
   * 구버전 호환 — 신규 코드는 agentSessionId 사용.
   */
  session_id?: string;
  requestId?: string;
  request_id?: string;
  [k: string]: unknown;
}
/**
 * orch→노드: 세션 결과 검수 확인을 원자 전이한다.
 */
export interface AcknowledgeSessionReview {
  type: "acknowledge_session_review";
  agentSessionId: string;
  /**
   * 구버전 호환.
   */
  session_id?: string;
  requestId?: string;
  request_id?: string;
  [k: string]: unknown;
}
/**
 * orch→노드: AskUserQuestion 응답.
 */
export interface Respond {
  type: "respond";
  agentSessionId: string;
  /**
   * 구버전 호환.
   */
  session_id?: string;
  inputRequestId?: string;
  /**
   * 구버전 호환.
   */
  request_id?: string;
  answers: {
    [k: string]: unknown;
  };
  requestId?: string;
  [k: string]: unknown;
}
/**
 * orch→노드: OpenAI Agents SDK tool approval 승인.
 */
export interface ApproveTool {
  type: "approve_tool";
  agentSessionId: string;
  /**
   * 구버전 호환.
   */
  session_id?: string;
  approvalId: string;
  /**
   * 구버전 호환.
   */
  approval_id?: string;
  requestId?: string;
  request_id?: string;
  alwaysApprove?: boolean;
  [k: string]: unknown;
}
/**
 * orch→노드: OpenAI Agents SDK tool approval 거부.
 */
export interface RejectTool {
  type: "reject_tool";
  agentSessionId: string;
  /**
   * 구버전 호환.
   */
  session_id?: string;
  approvalId: string;
  /**
   * 구버전 호환.
   */
  approval_id?: string;
  requestId?: string;
  request_id?: string;
  message?: string;
  alwaysReject?: boolean;
  [k: string]: unknown;
}
/**
 * orch→노드: soul-app WebRTC offer를 OpenAI Realtime call로 broker.
 */
export interface RealtimeCreateCall {
  type: "realtime_create_call";
  agentSessionId: string;
  session_id?: string;
  offerSdp: string;
  offer_sdp?: string;
  model?: string | null;
  voice?: string | null;
  instructions?: string | null;
  requestId?: string;
  request_id?: string;
  [k: string]: unknown;
}
/**
 * orch→노드: soul-app Realtime data-channel event를 persistence/relay 경로로 전달.
 */
export interface RealtimeEvent {
  type: "realtime_event";
  agentSessionId: string;
  session_id?: string;
  event: {
    [k: string]: unknown;
  };
  callId?: string | null;
  call_id?: string | null;
  requestId?: string;
  request_id?: string;
  [k: string]: unknown;
}
/**
 * orch→노드: realtime voice 중 발생한 tool approval decision을 영속화.
 */
export interface RealtimeResolveToolApproval {
  type: "realtime_resolve_tool_approval";
  agentSessionId: string;
  session_id?: string;
  approvalId: string;
  approval_id?: string;
  decision: "approved" | "rejected";
  message?: string;
  source?: "tap" | "voice";
  callId?: string | null;
  call_id?: string | null;
  requestId?: string;
  request_id?: string;
  [k: string]: unknown;
}
/**
 * orch→노드: 세션 목록 조회 명령.
 */
export interface ListSessions {
  type: "list_sessions";
  request_id?: string;
  requestId?: string;
  [k: string]: unknown;
}
/**
 * orch→노드: legacy single-frame attachment upload. 8MB 이하 backward compatibility path.
 */
export interface UploadAttachment {
  type: "upload_attachment";
  requestId?: string;
  session_id: string;
  filename?: string;
  content_type?: string;
  content_b64: string;
  [k: string]: unknown;
}
/**
 * orch→노드: chunked attachment upload 시작. temp file을 만든다.
 */
export interface UploadAttachmentStart {
  type: "upload_attachment_start";
  requestId?: string;
  upload_id: string;
  session_id: string;
  filename: string;
  content_type?: string;
  expected_size?: number;
  [k: string]: unknown;
}
/**
 * orch→노드: chunked attachment upload 청크 append.
 */
export interface UploadAttachmentChunk {
  type: "upload_attachment_chunk";
  requestId?: string;
  upload_id: string;
  chunk_index: number;
  content_b64: string;
  [k: string]: unknown;
}
/**
 * orch→노드: chunked attachment upload 완료. temp file을 최종 파일로 rename한다.
 */
export interface UploadAttachmentFinish {
  type: "upload_attachment_finish";
  requestId?: string;
  upload_id: string;
  [k: string]: unknown;
}
/**
 * orch→노드: chunked attachment upload 중단. temp file을 삭제한다.
 */
export interface UploadAttachmentAbort {
  type: "upload_attachment_abort";
  requestId?: string;
  upload_id: string;
  [k: string]: unknown;
}
/**
 * orch→노드: 세션 첨부 디렉토리 cleanup.
 */
export interface DeleteSessionAttachments {
  type: "delete_session_attachments";
  requestId?: string;
  session_id: string;
  [k: string]: unknown;
}
/**
 * orch→노드: 노드 로컬 첨부 파일 다운로드.
 */
export interface DownloadAttachment {
  type: "download_attachment";
  requestId?: string;
  path: string;
  [k: string]: unknown;
}
/**
 * orch→노드: agents.yaml 단일 agent profile 교체 계획(semantic object diff) read-only 조회. text diff는 include_text_diff=true일 때만 응답 diff에 포함한다.
 */
export interface PlanAgentProfileUpdate {
  type: "plan_agent_profile_update";
  request_id?: string;
  requestId?: string;
  profile: {
    [k: string]: unknown;
  };
  create_if_missing?: boolean;
  createIfMissing?: boolean;
  include_text_diff?: boolean;
  includeTextDiff?: boolean;
  /**
   * 응답에만 존재.
   */
  ok?: boolean;
  /**
   * 응답에만 존재.
   */
  config_path?: string;
  /**
   * 응답에만 존재. plan 시점 현재 config raw bytes의 sha256.
   */
  config_checksum?: string;
  /**
   * 응답에만 존재. expected_config_checksum에 넘길 수 있는 base checksum.
   */
  base_config_checksum?: string;
  /**
   * 응답에만 존재.
   */
  changed?: boolean;
  /**
   * 응답에만 존재. agent profile plan의 의미 변화 목록.
   */
  semantic_changes?: {
    op: "add_agent" | "replace_agent" | "update_agent_atom_contexts" | "no_change";
    agent_id: string;
    before: unknown;
    after: unknown;
    [k: string]: unknown;
  }[];
  /**
   * 응답에만 존재. diff가 실제 text diff를 포함하는지 여부.
   */
  text_diff_included?: boolean;
  /**
   * 응답에만 존재. include_text_diff=false이면 빈 문자열.
   */
  diff?: string;
  /**
   * 응답에만 존재. read-only plan은 snapshot 파일을 만들지 않는다.
   */
  snapshot_root?: string;
  /**
   * 응답에만 존재.
   */
  comment_preservation?: "not_preserved";
  [k: string]: unknown;
}
/**
 * orch→노드: agents.yaml 단일 agent profile 교체를 대상 노드에서 실제 적용. expected_config_checksum이 있으면 현재 raw config sha256과 일치해야 한다.
 */
export interface ApplyAgentProfileUpdate {
  type: "apply_agent_profile_update";
  request_id?: string;
  requestId?: string;
  profile: {
    [k: string]: unknown;
  };
  create_if_missing?: boolean;
  createIfMissing?: boolean;
  include_text_diff?: boolean;
  includeTextDiff?: boolean;
  /**
   * 선택. plan 응답의 config_checksum/base_config_checksum과 비교하여 stale apply를 거부.
   */
  expected_config_checksum?: string | null;
  expectedConfigChecksum?: string | null;
  /**
   * 응답에만 존재.
   */
  ok?: boolean;
  /**
   * 응답에만 존재.
   */
  config_path?: string;
  /**
   * 응답에만 존재. 적용 후 config raw bytes의 sha256.
   */
  config_checksum?: string;
  /**
   * 응답에만 존재. 적용 직전 config raw bytes의 sha256.
   */
  base_config_checksum?: string;
  /**
   * 응답에만 존재.
   */
  changed?: boolean;
  /**
   * 응답에만 존재. agent profile apply의 의미 변화 목록.
   */
  semantic_changes?: {
    op: "add_agent" | "replace_agent" | "update_agent_atom_contexts" | "no_change";
    agent_id: string;
    before?: unknown;
    after?: unknown;
    [k: string]: unknown;
  }[];
  /**
   * 응답에만 존재. diff가 실제 text diff를 포함하는지 여부.
   */
  text_diff_included?: boolean;
  /**
   * 응답에만 존재. include_text_diff=false이면 빈 문자열.
   */
  diff?: string;
  /**
   * 응답에만 존재. 변경 전 raw config snapshot path.
   */
  snapshot_path?: string | null;
  /**
   * 응답에만 존재.
   */
  applied_at?: string | null;
  /**
   * 응답에만 존재.
   */
  reload_ok?: boolean;
  /**
   * 응답에만 존재.
   */
  snapshot_root?: string;
  /**
   * 응답에만 존재.
   */
  comment_preservation?: "not_preserved";
  /**
   * 응답에만 존재.
   */
  agent_count?: number;
  /**
   * 응답에만 존재. apply 후 target node registry가 광고하는 최신 agent summary.
   */
  agents?: {
    id?: string;
    name?: string;
    backend?: string;
    portrait_url?: string;
    max_turns?: number | null;
    portrait_b64?: string;
    [k: string]: unknown;
  }[];
  /**
   * 응답에만 존재. apply 후 target node registry의 backend 목록.
   */
  supported_backends?: string[];
  /**
   * 응답에만 존재. apply 후 target node agent catalog 기반 capability.
   */
  capabilities?: {
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
/**
 * orch→노드: 대상 노드의 managed agents.yaml snapshot inventory 조회.
 */
export interface ListAgentsConfigSnapshots {
  type: "list_agents_config_snapshots";
  request_id?: string;
  requestId?: string;
  /**
   * 응답에만 존재.
   */
  ok?: boolean;
  /**
   * 응답에만 존재. 최신순 snapshot 목록.
   */
  snapshots?: {
    snapshot_id?: string;
    snapshot_path?: string;
    created_at?: string;
    mtime?: string;
    size_bytes?: number;
    config_path?: string;
    config_name?: string;
    config_hash?: string;
    [k: string]: unknown;
  }[];
  [k: string]: unknown;
}
/**
 * orch→노드: managed snapshot path 또는 snapshot id로 agents.yaml rollback.
 */
export interface RollbackAgentsConfig {
  type: "rollback_agents_config";
  request_id?: string;
  requestId?: string;
  /**
   * 요청에서는 restore 대상 snapshot path. 응답에서는 rollback 직전 raw config snapshot path.
   */
  snapshot_path?: string | null;
  snapshotPath?: string;
  snapshot_id?: string;
  snapshotId?: string;
  include_text_diff?: boolean;
  includeTextDiff?: boolean;
  /**
   * 응답에만 존재.
   */
  ok?: boolean;
  /**
   * 응답에만 존재.
   */
  config_path?: string;
  /**
   * 응답에만 존재. rollback 후 config raw bytes의 sha256.
   */
  config_checksum?: string;
  /**
   * 응답에만 존재. rollback 직전 config raw bytes의 sha256.
   */
  base_config_checksum?: string;
  /**
   * 응답에만 존재.
   */
  changed?: boolean;
  /**
   * 응답에만 존재. rollback은 보통 빈 배열.
   */
  semantic_changes?: {
    [k: string]: unknown;
  }[];
  /**
   * 응답에만 존재. diff가 실제 text diff를 포함하는지 여부.
   */
  text_diff_included?: boolean;
  /**
   * 응답에만 존재. include_text_diff=false이면 빈 문자열.
   */
  diff?: string;
  /**
   * 응답에만 존재. rollback 직전 raw config snapshot path alias.
   */
  rollback_snapshot_path?: string | null;
  /**
   * 응답에만 존재. 요청에서 지정한 restore 대상 path.
   */
  restored_snapshot_path?: string | null;
  /**
   * 응답에만 존재. 요청에서 지정한 restore 대상 id.
   */
  restored_snapshot_id?: string | null;
  /**
   * 응답에만 존재.
   */
  applied_at?: string | null;
  /**
   * 응답에만 존재.
   */
  reload_ok?: boolean;
  /**
   * 응답에만 존재.
   */
  snapshot_root?: string;
  /**
   * 응답에만 존재.
   */
  comment_preservation?: "not_preserved";
  /**
   * 응답에만 존재.
   */
  agent_count?: number;
  /**
   * 응답에만 존재. rollback 후 target node registry가 광고하는 최신 agent summary.
   */
  agents?: {
    id?: string;
    name?: string;
    backend?: string;
    portrait_url?: string;
    max_turns?: number | null;
    portrait_b64?: string;
    [k: string]: unknown;
  }[];
  /**
   * 응답에만 존재. rollback 후 target node registry의 backend 목록.
   */
  supported_backends?: string[];
  /**
   * 응답에만 존재. rollback 후 target node agent catalog 기반 capability.
   */
  capabilities?: {
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
/**
 * orch→노드: 헬스체크 명령.
 */
export interface HealthCheck {
  type: "health_check";
  request_id?: string;
  requestId?: string;
  [k: string]: unknown;
}
/**
 * orch→노드: 라이브 이벤트 구독.
 */
export interface SubscribeEvents {
  type: "subscribe_events";
  session_id?: string;
  agentSessionId?: string;
  after_id?: number;
  request_id?: string;
  requestId?: string;
  subscribeId?: string;
  [k: string]: unknown;
}
/**
 * orch→노드: Claude OAuth 토큰 존재 여부 조회. 응답도 동일 type, has_token 추가.
 */
export interface ClaudeAuthStatus {
  type: "claude_auth_status";
  requestId?: string;
  /**
   * 응답에만 존재. true이면 토큰 저장됨.
   */
  has_token?: boolean;
  [k: string]: unknown;
}
/**
 * orch→노드: Claude OAuth 토큰 설정.
 */
export interface ClaudeAuthSetToken {
  type: "claude_auth_set_token";
  requestId?: string;
  token?: string;
  refresh_token?: string;
  expires_in?: number | null;
  scope?: string;
  /**
   * 응답에만 존재.
   */
  success?: boolean;
  [k: string]: unknown;
}
/**
 * orch→노드: Claude OAuth 토큰 삭제.
 */
export interface ClaudeAuthDeleteToken {
  type: "claude_auth_delete_token";
  requestId?: string;
  /**
   * 응답에만 존재.
   */
  success?: boolean;
  [k: string]: unknown;
}
/**
 * orch→노드: Anthropic OAuth usage 조회.
 */
export interface ClaudeAuthGetUsage {
  type: "claude_auth_get_usage";
  requestId?: string;
  /**
   * 응답에만 존재.
   */
  success?: boolean;
  /**
   * 실패 응답에만 존재.
   */
  error?: string;
  /**
   * 성공 응답: Anthropic API JSON.
   */
  data?: {
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
/**
 * orch→노드: Anthropic OAuth profile 조회.
 */
export interface ClaudeAuthGetProfile {
  type: "claude_auth_get_profile";
  requestId?: string;
  /**
   * 응답에만 존재.
   */
  success?: boolean;
  /**
   * 실패 응답에만 존재.
   */
  error?: string;
  /**
   * 성공 응답: Anthropic API JSON.
   */
  data?: {
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
