/* AUTO-GENERATED — do not edit. Run packages/wire-schema/scripts/generate.sh */

/**
 * 노드 ↔ 오케스트레이터 WebSocket 메시지 정본. 51개 $defs (wire 21 + SSE event 30). 출처: soul-server/upstream/protocol.py · adapter.py · event_relay.py · command_handler.py · claude_auth_handlers.py / orch-server/constants.py KNOWN_SSE_EVENT_TYPES L60-69 (실측 2026-05-16).
 */
export type SoulstreamUpstreamProtocol =
  | NodeRegister
  | SessionCreated
  | SessionEventEnvelope
  | SessionsUpdate
  | HealthStatus
  | SessionUpdated
  | SessionDeleted
  | ErrorMessage
  | InterveneAck
  | RespondAck
  | CreateSession
  | Intervene
  | Respond
  | ListSessions
  | HealthCheck
  | SubscribeEvents
  | ClaudeAuthStatus
  | ClaudeAuthSetToken
  | ClaudeAuthDeleteToken
  | ClaudeAuthGetUsage
  | ClaudeAuthGetProfile;

/**
 * 노드→orch: 등록. soul-server/upstream/adapter.py:_build_registration_msg L197-247.
 */
export interface NodeRegister {
  type: "node_register";
  node_id: string;
  host?: string;
  port?: number;
  /**
   * 노드 자체 가용성 정보. 예: {max_concurrent: 5}
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
 * 노드→orch: 세션 생성 응답 또는 broadcast. command_handler.py L220-228 + event_relay.py L119-133.
 */
export interface SessionCreated {
  type: "session_created";
  agentSessionId?: string;
  requestId?: string;
  /**
   * broadcast 경로에서 송신되는 세션 정보 (to_session_info 결과).
   */
  session?: {
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
 * 노드→orch: SSE 이벤트 wrapper. event_relay.py:relay_events L175-179. event.event 안에 SSEEvent* 중 하나가 packed.
 */
export interface SessionEventEnvelope {
  type: "event";
  agentSessionId: string;
  /**
   * 구버전 호환 — 신규 코드는 agentSessionId 사용.
   */
  session_id?: string;
  /**
   * SSE event payload. KNOWN_SSE_EVENT_TYPES 중 하나 (orch-server/constants.py L59-69).
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
    | SSEEventThinking
    | SSEEventTextStart
    | SSEEventTextDelta
    | SSEEventTextEnd
    | SSEEventToolStart
    | SSEEventToolResult
    | SSEEventResult
    | SSEEventPromptSuggestion
    | SSEEventSubagentStart
    | SSEEventSubagentStop
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
 * SSE: AskUserQuestion 요청. 별도 wire 메시지로도 forwarding (constants.py EVT_INPUT_REQUEST L41).
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
 * SSE: AssistantMessage.error 별 이벤트 — authentication_failed/billing_error/rate_limit 등 API 수준 에러를 dashboard가 분기 표시. Python `AssistantErrorEngineEvent` (soul-server/src/soul_server/engine/types.py:329-349) 정합.
 */
export interface SSEEventAssistantError {
  type: "assistant_error";
  error_type: string;
  model?: string;
  message_id?: string;
  [k: string]: unknown;
}
/**
 * SSE: Claude CLI가 세션 복귀 시 발행하는 요약. Python `AwaySummaryEngineEvent` (soul-server/src/soul_server/engine/types.py:188-204) 정합.
 */
export interface SSEEventAwaySummary {
  type: "away_summary";
  content: string;
  [k: string]: unknown;
}
/**
 * 노드→orch: 전체 세션 목록 dump. adapter.py:_send_initial_sessions L313-325, command_handler.py:_handle_list_sessions L299-307.
 */
export interface SessionsUpdate {
  type: "sessions_update";
  sessions: {
    [k: string]: unknown;
  }[];
  total?: number;
  requestId?: string;
  [k: string]: unknown;
}
/**
 * 노드→orch: 헬스 응답. command_handler.py:_handle_health_check L309-317.
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
 * 노드→orch: 세션 상태 변경 broadcast. event_relay.py:_dispatch_broadcast_event L134-138. broadcaster 이벤트 dict가 그대로 spread되므로 페이로드는 inline 확장 가능.
 */
export interface SessionUpdated {
  type: "session_updated";
  agent_session_id?: string;
  agentSessionId?: string;
  [k: string]: unknown;
}
/**
 * 노드→orch: 세션 삭제 broadcast. event_relay.py L139-143.
 */
export interface SessionDeleted {
  type: "session_deleted";
  agent_session_id?: string;
  agentSessionId?: string;
  [k: string]: unknown;
}
/**
 * 노드→orch: 에러 응답. adapter.py:_send_error L334-346.
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
 * 노드→orch: intervene 명령 ACK. command_handler.py:_handle_intervene L249-254. orch _send_command Future 매칭에 사용.
 */
export interface InterveneAck {
  type: "intervene_ack";
  requestId: string;
  status?: "ok";
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
 * orch→노드: 세션 생성. protocol.py:CreateSessionCmd L15-27 + 실측 caller_info 키.
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
   * Codex-only reasoning effort. Missing means codex adapter default xhigh.
   */
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  [k: string]: unknown;
}
/**
 * orch→노드: 개입 명령. protocol.py:InterveneCmd L30-34 + command_handler.py L237-243 attachment_paths/caller_info.
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
  caller_info?: {
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
/**
 * orch→노드: AskUserQuestion 응답. protocol.py:RespondCmd L37-48 + command_handler.py L271-297.
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
 * orch→노드: 세션 목록 조회. protocol.py:ListSessionsCmd L51-53.
 */
export interface ListSessions {
  type: "list_sessions";
  request_id?: string;
  requestId?: string;
  [k: string]: unknown;
}
/**
 * orch→노드: 헬스체크. protocol.py:HealthCheckCmd L56-58.
 */
export interface HealthCheck {
  type: "health_check";
  request_id?: string;
  requestId?: string;
  [k: string]: unknown;
}
/**
 * orch→노드: 라이브 이벤트 구독. protocol.py:SubscribeEventsCmd L61-65 + command_handler.py L319-333.
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
 * orch→노드: Claude OAuth 토큰 존재 여부 조회. claude_auth_handlers.py:handle_auth_status L26-33. 응답도 동일 type, has_token 추가.
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
 * orch→노드: Claude OAuth 토큰 설정. claude_auth_handlers.py:handle_auth_set_token L36-65.
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
 * orch→노드: Claude OAuth 토큰 삭제. claude_auth_handlers.py:handle_auth_delete_token L68-76.
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
 * orch→노드: Anthropic OAuth usage 조회. claude_auth_handlers.py:handle_auth_api_request L79-119 (URL=ANTHROPIC_USAGE_URL).
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
 * orch→노드: Anthropic OAuth profile 조회. claude_auth_handlers.py:handle_auth_api_request L79-119 (URL=ANTHROPIC_PROFILE_URL).
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
