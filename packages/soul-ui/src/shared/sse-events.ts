/**
 * Soul Dashboard - SSE 이벤트 타입 정의
 *
 * Soul SSE 이벤트의 페이로드 타입과 유니온, 그리고 대시보드 SSE 래퍼.
 * Python Soul 서버의 schemas.py와 동기화를 유지합니다.
 */

import type { SessionStatus } from "./session-types";

// === SSE Event Types ===

/** Soul SSE 이벤트 타입 (Python SSEEventType과 동기화) */
export type SSEEventType =
  // 제어 이벤트
  | "init"
  | "reconnected"
  // 기본 이벤트
  | "progress"
  | "memory"
  | "session"
  | "intervention_sent"
  | "user_message"
  | "system_message"
  | "debug"
  | "complete"
  | "error"
  // 세분화 이벤트 (대시보드용)
  | "assistant_error"
  | "credential_alert"
  | "thinking"
  | "text_start"
  | "text_delta"
  | "text_end"
  | "tool_start"
  | "tool_result"
  | "agent_updated"
  | "handoff_requested"
  | "handoff_occurred"
  | "tool_approval_requested"
  | "tool_approval_resolved"
  | "guardrail_tripwire"
  | "result"
  | "away_summary"
  | "prompt_suggestion"
  // 서브에이전트 이벤트
  | "subagent_start"
  | "subagent_stop"
  // Claude SDK runtime 상태 이벤트
  | "claude_runtime_session_state"
  | "claude_runtime_task_started"
  | "claude_runtime_task_updated"
  | "claude_runtime_task_progress"
  | "claude_runtime_task_notification"
  // 대시보드 내부 이벤트
  | "context_usage"
  | "compact"
  | "reconnect"
  // 사용자 입력 요청 이벤트
  | "input_request"
  | "input_request_expired"
  | "input_request_responded"
  // 히스토리 동기화 이벤트
  | "history_sync"
  // LLM 프록시 이벤트
  | "assistant_message"
  // 메타데이터 이벤트
  | "metadata_updated"
  // 뷰포트 가상화 이벤트 (Phase 3 viewport API)
  /** @deprecated Phase 2-B-1: 발신 폐기. 인터페이스는 wire 호환성을 위해 보존. */
  | "subtree_update";

// === Soul SSE Event Payloads ===

export interface ProgressEvent {
  type: "progress";
  text: string;
}

export interface MemoryEvent {
  type: "memory";
  used_gb: number;
  total_gb: number;
  percent: number;
}

export interface SessionEvent {
  type: "session";
  session_id: string;
  pid?: number;
}

export interface InterventionSentEvent {
  type: "intervention_sent";
  user: string;
  text: string;
  /** 부모 이벤트 ID (Phase 2: 타입 통일용, 서버에서 설정하지 않음) */
  /** @deprecated Phase 2-B-1: 백엔드 fallback 채움 폐기로 NULL 송출. FE·외부는 사용하지 않음. */
  parent_event_id?: string;
  /**
   * F-9 fix(2026-05-08): 발신자 신원(통합 v1, atom ed3a216d). user_message와 동일
   * 형상으로 메시지-단위 발신자 표시를 가능하게 한다. 부재 시 클라이언트는 세션-단위
   * metadata로 fallback, 그것도 없으면 dashboard 사용자 portrait로 fallback.
   */
  caller_info?: CallerInfo;
  /**
   * Phase A context 정본 (atom d7a1ad86 정본 둘 안티패턴 차단):
   * Python `on_intervention_sent`가 event/intervention_msg dict 통합 후 wire에 박는 context_items.
   * UserMessageEvent.context와 동일 의미 — InterventionMessage가 ContextBlock 렌더링.
   */
  context?: ContextItem[];
}

export interface ContextItem {
  key: string;
  label: string;
  content: unknown;
}

/**
 * caller_info 통합 v1 (atom ed3a216d) — 발신자 신원 wire 정본.
 *
 * soul-server `task_factory.py`와 `task_executor.py`가 user_message 이벤트와 세션
 * metadata에 같은 dict를 첨부한다. 클라이언트는 메시지 단위(user_message.caller_info)와
 * 세션 단위(SessionSummary.metadata의 caller_info entry) 양쪽에서 동일 형상을 본다.
 *
 * 우선순위: 메시지 단위 > 세션 단위 > 노드 사용자 fallback (UserMessage 기준).
 */
export interface CallerInfo {
  /**
   * F-11 (2026-05-09): 'system' 추가 — soulstream 서버 자신이 발신한 lifecycle
   * 인터벤션(graceful_shutdown 종료 예고, resume_shutdown_sessions 재개 안내)을 표시한다.
   */
  source: "browser" | "slack" | "agent" | "soul-app" | "api" | "system";
  display_name?: string;
  user_id?: string;
  avatar_url?: string;
  email?: string;
  agent_node?: string;
  agent_id?: string | null;
  agent_name?: string | null;
  slack?: { channel_id?: string; thread_ts?: string; user_id?: string };
  /** source-고유 컨텍스트 graceful (Phase 3 이전 데이터 호환). */
  [key: string]: unknown;
}

/** 사용자가 보낸 초기 프롬프트 (세션 시작 시 대시보드가 생성) */
export interface UserMessageEvent {
  type: "user_message";
  /** Claude 세션: 프롬프트 전체 텍스트 */
  text?: string;
  /** Claude 세션: 사용자 ID */
  user?: string;
  /** Claude 세션: 구조화된 맥락 항목 배열 (Phase 2에서 렌더링) */
  context?: ContextItem[];
  /** LLM 세션: OpenAI 형식 메시지 배열 (정본) */
  messages?: Array<{role: string; content: unknown}>;
  /** LLM 세션: 클라이언트 ID */
  client_id?: string;
  /** 부모 이벤트 ID (Phase 2: 타입 통일용, 서버에서 설정하지 않음) */
  /** @deprecated Phase 2-B-1: 백엔드 fallback 채움 폐기로 NULL 송출. FE·외부는 사용하지 않음. */
  parent_event_id?: string;
  /** 발신자 신원 — 통합 v1 정본 (atom ed3a216d). 신규 코드는 이쪽으로. */
  caller_info?: CallerInfo;
  /** @deprecated 레거시 top-level source — Phase 3 이전 데이터 호환 전용. 신규 데이터는 caller_info.source 사용. */
  source?: "agent";
  /** @deprecated 레거시 — caller_info.agent_node 사용. */
  agent_node?: string;
  /** @deprecated 레거시 — caller_info.agent_id 사용. */
  agent_id?: string | null;
  /** @deprecated 레거시 — caller_info.agent_name 사용. */
  agent_name?: string | null;
}

/** 시스템 프롬프트 이벤트 (에이전트 세션 시작 시 emit) */
export interface SystemMessageEvent {
  type: "system_message";
  text: string;
}

export interface DebugEvent {
  type: "debug";
  message: string;
  timestamp?: number;
  /** @deprecated Phase 2-B-1: 백엔드 fallback 채움 폐기로 NULL 송출. FE·외부는 사용하지 않음. */
  parent_event_id?: string;
}

/** Claude API 에러 이벤트 (인증 실패, 과금 에러 등) */
export interface AssistantErrorEvent {
  type: "assistant_error";
  timestamp: number;
  /** 에러 타입: authentication_failed, billing_error, rate_limit, invalid_request, server_error, unknown */
  error_type: string;
  model?: string;
  message_id?: string;
  /** @deprecated Phase 2-B-1: 백엔드 fallback 채움 폐기로 NULL 송출. FE·외부는 사용하지 않음. */
  parent_event_id?: string;
}

/** Rate limit 사용량 경고 이벤트 */
export interface CredentialAlertEvent {
  type: "credential_alert";
  utilization?: number;
  rate_limit_type?: string;
  status?: string;
  resets_at?: string;
  timestamp?: number;
  /** @deprecated Phase 2-B-1: 백엔드 fallback 채움 폐기로 NULL 송출. FE·외부는 사용하지 않음. */
  parent_event_id?: string;
}

export interface CompleteEvent {
  type: "complete";
  result: string;
  attachments: string[];
  claude_session_id?: string;
  /** 토큰 사용량 (Codex turn.completed 등) */
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens?: number;
    reasoning_output_tokens?: number;
  };
  /** 총 비용 (USD). 제공되는 백엔드에서만 표시 */
  total_cost_usd?: number;
  /** 부모 이벤트 ID (Phase 2: 순수 parent 기반 배치용) */
  /** @deprecated Phase 2-B-1: 백엔드 fallback 채움 폐기로 NULL 송출. FE·외부는 사용하지 않음. */
  parent_event_id?: string;
}

export interface ErrorEvent {
  type: "error";
  message: string;
  error_code?: string;
  /** 부모 이벤트 ID (Phase 2: 순수 parent 기반 배치용) */
  /** @deprecated Phase 2-B-1: 백엔드 fallback 채움 폐기로 NULL 송출. FE·외부는 사용하지 않음. */
  parent_event_id?: string;
}

export interface ContextUsageEvent {
  type: "context_usage";
  used_tokens: number;
  max_tokens: number;
  percent: number;
}

export interface CompactEvent {
  type: "compact";
  trigger: string;
  message: string;
  /** 부모 이벤트 ID (Phase 2: 순수 parent 기반 배치용) */
  /** @deprecated Phase 2-B-1: 백엔드 fallback 채움 폐기로 NULL 송출. FE·외부는 사용하지 않음. */
  parent_event_id?: string;
}

// === 세분화 SSE Events (대시보드 전용) ===

/** Extended Thinking 이벤트 */
export interface ThinkingEvent {
  type: "thinking";
  timestamp: number;
  /** Claude-style extended thinking payload. */
  thinking?: string;
  /** Codex app-server emits thinking item content as text. */
  text?: string;
  signature?: string;
  /** 부모 이벤트 ID (서브에이전트 내부 노드 배치용) */
  /** @deprecated Phase 2-B-1: 백엔드 fallback 채움 폐기로 NULL 송출. FE·외부는 사용하지 않음. */
  parent_event_id?: string;
}

export interface TextStartEvent {
  type: "text_start";
  timestamp: number;
  /** 부모 이벤트 ID (서브에이전트 내부 노드 배치용) */
  /** @deprecated Phase 2-B-1: 백엔드 fallback 채움 폐기로 NULL 송출. FE·외부는 사용하지 않음. */
  parent_event_id?: string;
}

export interface TextDeltaEvent {
  type: "text_delta";
  timestamp: number;
  text: string;
  /** 부모 이벤트 ID (서브에이전트 내부 노드 배치용) */
  /** @deprecated Phase 2-B-1: 백엔드 fallback 채움 폐기로 NULL 송출. FE·외부는 사용하지 않음. */
  parent_event_id?: string;
}

export interface TextEndEvent {
  type: "text_end";
  timestamp: number;
  /** 부모 이벤트 ID (서브에이전트 내부 노드 배치용) */
  /** @deprecated Phase 2-B-1: 백엔드 fallback 채움 폐기로 NULL 송출. FE·외부는 사용하지 않음. */
  parent_event_id?: string;
}

export interface ToolStartEvent {
  type: "tool_start";
  timestamp: number;
  tool_name: string;
  tool_input: Record<string, unknown> | string;
  tool_input_preview?: string;
  tool_input_truncated?: boolean;
  timeline_id?: string;
  has_trace?: boolean;
  status?: "running" | "completed" | "error";
  started_at?: number | null;
  completed_at?: number | null;
  duration_ms?: number | null;
  /** SDK ToolUseBlock ID (tool_result 매칭용) */
  tool_use_id?: string;
  /** 부모 이벤트 ID (서브에이전트 내부 노드 배치용) */
  /** @deprecated Phase 2-B-1: 백엔드 fallback 채움 폐기로 NULL 송출. FE·외부는 사용하지 않음. */
  parent_event_id?: string;
}

export interface ToolResultEvent {
  type: "tool_result";
  timestamp: number;
  tool_name: string;
  result: string;
  result_preview?: string;
  result_truncated?: boolean;
  timeline_id?: string;
  has_trace?: boolean;
  status?: "completed" | "error";
  started_at?: number | null;
  completed_at?: number | null;
  duration_ms?: number | null;
  is_error: boolean;
  /** SDK ToolUseBlock ID (tool_start 매칭용) */
  tool_use_id?: string;
  /** 부모 이벤트 ID (서브에이전트 내부 노드 배치용) */
  /** @deprecated Phase 2-B-1: 백엔드 fallback 채움 폐기로 NULL 송출. FE·외부는 사용하지 않음. */
  parent_event_id?: string;
}

export interface AgentUpdatedEvent {
  type: "agent_updated";
  agent_name: string;
  timestamp: number;
}

export interface HandoffRequestedEvent {
  type: "handoff_requested";
  source_agent: string;
  target_agent: string;
  tool_use_id?: string;
  handoff_input?: unknown;
  timestamp: number;
}

export interface HandoffOccurredEvent {
  type: "handoff_occurred";
  source_agent: string;
  target_agent: string;
  tool_use_id?: string;
  timestamp: number;
}

export interface ToolApprovalRequestedEvent {
  type: "tool_approval_requested";
  approval_id: string;
  tool_use_id?: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  agent_name?: string;
  timestamp: number;
}

export interface ToolApprovalResolvedEvent {
  type: "tool_approval_resolved";
  approval_id: string;
  decision: "approved" | "rejected";
  approved: boolean;
  rejected: boolean;
  message?: string;
  timestamp: number;
}

export interface GuardrailTripwireEvent {
  type: "guardrail_tripwire";
  guardrail_type: string;
  guardrail_name: string;
  message: string;
  output_info?: unknown;
  timestamp: number;
}

export interface ResultEvent {
  type: "result";
  timestamp: number;
  success: boolean;
  output: string;
  error?: string;
  /** 토큰 사용량 */
  usage?: { input_tokens: number; output_tokens: number };
  /** 총 비용 (USD) */
  total_cost_usd?: number;
  /** 종료 사유 */
  stop_reason?: string;
  /** 에러 목록 */
  errors?: string[];
  /** 모델별 사용량 */
  model_usage?: Record<string, unknown>;
  /** 권한 거부 목록 */
  permission_denials?: string[];
  /** 부모 이벤트 ID (서브에이전트 내부 노드 배치용) */
  /** @deprecated Phase 2-B-1: 백엔드 fallback 채움 폐기로 NULL 송출. FE·외부는 사용하지 않음. */
  parent_event_id?: string;
}

/** away_summary (recap) 이벤트 — 세션 복귀 시 요약 */
export interface AwaySummaryEvent {
  type: "away_summary";
  timestamp: number;
  content: string;
  /** @deprecated Phase 2-B-1: 백엔드 fallback 채움 폐기로 NULL 송출. FE·외부는 사용하지 않음. */
  parent_event_id?: string;
}

/** prompt_suggestion 이벤트 — 다음 prompt 후보 (turn 직후, 1개) */
export interface PromptSuggestionEvent {
  type: "prompt_suggestion";
  timestamp: number;
  text: string;
  /** @deprecated Phase 2-B-1: 백엔드 fallback 채움 폐기로 NULL 송출. FE·외부는 사용하지 않음. */
  parent_event_id?: string;
}

/** 서브에이전트 시작 이벤트 */
export interface SubagentStartEvent {
  type: "subagent_start";
  timestamp: number;
  agent_id: string;
  agent_type: string;
  /** @deprecated Phase 2-B-1: 백엔드 fallback 채움 폐기로 NULL 송출. FE·외부는 사용하지 않음. */
  parent_event_id: string;
}

/** 서브에이전트 종료 이벤트 */
export interface SubagentStopEvent {
  type: "subagent_stop";
  timestamp: number;
  agent_id: string;
  /** @deprecated Phase 2-B-1: 백엔드 fallback 채움 폐기로 NULL 송출. FE·외부는 사용하지 않음. */
  parent_event_id?: string;
}

export interface ClaudeRuntimeSessionStateEvent {
  type: "claude_runtime_session_state";
  state: "idle" | "running" | "requires_action";
  session_id?: string;
  timestamp: number;
}

export interface ClaudeRuntimeTaskStartedEvent {
  type: "claude_runtime_task_started";
  task_id: string;
  session_id?: string;
  tool_use_id?: string;
  description?: string;
  task_type?: string;
  workflow_name?: string;
  prompt?: string;
  skip_transcript?: boolean;
  timestamp: number;
}

export interface ClaudeRuntimeTaskUpdatedEvent {
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
    [key: string]: unknown;
  };
  timestamp: number;
}

export interface ClaudeRuntimeTaskProgressEvent {
  type: "claude_runtime_task_progress";
  task_id: string;
  session_id?: string;
  tool_use_id?: string;
  description?: string;
  usage?: Record<string, unknown>;
  last_tool_name?: string;
  summary?: string;
  timestamp: number;
}

export interface ClaudeRuntimeTaskNotificationEvent {
  type: "claude_runtime_task_notification";
  task_id: string;
  status: "completed" | "failed" | "stopped";
  session_id?: string;
  tool_use_id?: string;
  output_file?: string;
  summary?: string;
  usage?: Record<string, unknown>;
  skip_transcript?: boolean;
  timestamp: number;
}

export interface ReconnectEvent {
  type: "reconnect";
  last_event_id?: number;
}

/** 히스토리 동기화 완료 이벤트 (저장된 이벤트 전송 후 서버가 발행) */
export interface HistorySyncEvent {
  type: "history_sync";
  last_event_id: number;
  is_live: boolean;
  /** 서버가 판정한 현재 세션 상태 (정본) */
  status?: SessionStatus;
}

/** 사용자 입력 요청 — 질문 항목 */
export interface InputRequestQuestion {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

/** 사용자 입력 요청 이벤트 (AskUserQuestion) */
export interface InputRequestEvent {
  type: "input_request";
  timestamp: number;
  request_id: string;
  tool_use_id?: string;
  questions: InputRequestQuestion[];
  /** @deprecated Phase 2-B-1: 백엔드 fallback 채움 폐기로 NULL 송출. FE·외부는 사용하지 않음. */
  parent_event_id?: string;
  /** 서버가 타이머를 시작한 시각 (Unix epoch) */
  started_at: number;
  /** 응답 대기 타임아웃 (초) */
  timeout_sec: number;
}

/** 사용자 입력 요청 만료 이벤트 — 클라이언트가 선택 창을 닫아야 함 */
export interface InputRequestExpiredEvent {
  type: "input_request_expired";
  request_id: string;
  /** @deprecated Phase 2-B-1: 백엔드 fallback 채움 폐기로 NULL 송출. FE·외부는 사용하지 않음. */
  parent_event_id?: string;
  timestamp: number;
}

/** 사용자 입력 요청 응답 완료 이벤트 — 클라이언트가 선택 창을 닫아야 함 */
export interface InputRequestRespondedEvent {
  type: "input_request_responded";
  request_id: string;
  /** @deprecated Phase 2-B-1: 백엔드 fallback 채움 폐기로 NULL 송출. FE·외부는 사용하지 않음. */
  parent_event_id?: string;
  timestamp: number;
}

/** LLM 프록시 응답 이벤트 */
export interface AssistantMessageEvent {
  type: "assistant_message";
  content: string;
  usage?: { input_tokens: number; output_tokens: number };
  model?: string;
  provider?: string;
  timestamp?: number;
  /** 부모 이벤트 ID (Phase 2: 순수 parent 기반 배치용) */
  /** @deprecated Phase 2-B-1: 백엔드 fallback 채움 폐기로 NULL 송출. FE·외부는 사용하지 않음. */
  parent_event_id?: string;
}

/**
 * @deprecated Phase 2-B-1: 백엔드 발신 폐기. 인터페이스는 wire 호환성을 위해 보존.
 *
 * 뷰포트 subtree_height 증분 갱신 이벤트 (Phase 3 viewport API).
 *
 * 새 이벤트가 추가될 때 조상 노드의 subtree_height가 증가한 사실을
 * 실시간으로 클라이언트에 전달한다. 클라이언트는 이 이벤트를 받아
 * 로컬 트리의 subtree_height와 totalSubtreeHeight를 갱신한다.
 *
 * **JSON 직렬화 주의**: Python 서버는 `dict[int, int]`로 송신하지만
 * JSON 표준상 object key는 항상 string이므로 TypeScript 수신 타입은
 * `Record<string, number>`다. 소비자는 `Number(idStr)`로 재변환하여
 * 조상 노드를 조회해야 한다.
 */
export interface SubtreeUpdateSSEEvent {
  type: "subtree_update";
  timestamp: number;
  affected_event_ids: number[];
  /** ancestor_id(string) → +delta 매핑. JSON 직렬화로 key가 string. */
  deltas: Record<string, number>;
  new_total_subtree_height: number;
  trigger_event_id?: number | null;
}

/** Soul에서 수신하는 모든 SSE 이벤트 유니온 */
export type SoulSSEEvent =
  | ProgressEvent
  | MemoryEvent
  | SessionEvent
  | InterventionSentEvent
  | UserMessageEvent
  | SystemMessageEvent
  | DebugEvent
  | CompleteEvent
  | ErrorEvent
  | ContextUsageEvent
  | CompactEvent
  | AssistantErrorEvent
  | CredentialAlertEvent
  | ThinkingEvent
  | TextStartEvent
  | TextDeltaEvent
  | TextEndEvent
  | ToolStartEvent
  | ToolResultEvent
  | AgentUpdatedEvent
  | HandoffRequestedEvent
  | HandoffOccurredEvent
  | ToolApprovalRequestedEvent
  | ToolApprovalResolvedEvent
  | GuardrailTripwireEvent
  | ResultEvent
  | SubagentStartEvent
  | SubagentStopEvent
  | ClaudeRuntimeSessionStateEvent
  | ClaudeRuntimeTaskStartedEvent
  | ClaudeRuntimeTaskUpdatedEvent
  | ClaudeRuntimeTaskProgressEvent
  | ClaudeRuntimeTaskNotificationEvent
  | ReconnectEvent
  | InputRequestEvent
  | InputRequestExpiredEvent
  | InputRequestRespondedEvent
  | HistorySyncEvent
  | AssistantMessageEvent
  | AwaySummaryEvent
  | PromptSuggestionEvent
  | SubtreeUpdateSSEEvent;

// === Dashboard SSE Event (서버 → 클라이언트) ===

/**
 * 대시보드 서버가 클라이언트에 보내는 SSE 이벤트 래퍼.
 *
 * Soul의 이벤트를 그대로 중계하되, 세션 식별자를 추가합니다.
 */
export interface DashboardSSEEvent {
  /** EventStore의 단조증가 ID */
  eventId: number;
  /** 세션 식별자 (agentSessionId) */
  agentSessionId: string;
  /** 원본 Soul 이벤트 */
  event: SoulSSEEvent;
}
