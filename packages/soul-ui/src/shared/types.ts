/**
 * Soul Dashboard - 공유 타입 정의
 *
 * 서버와 클라이언트 양쪽에서 사용하는 이벤트, 세션, 카드 타입.
 * Python Soul 서버의 schemas.py와 동기화를 유지합니다.
 */

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
  | "debug"
  | "complete"
  | "error"
  // 세분화 이벤트 (대시보드용)
  | "thinking"
  | "text_start"
  | "text_delta"
  | "text_end"
  | "tool_start"
  | "tool_result"
  | "result"
  // 서브에이전트 이벤트
  | "subagent_start"
  | "subagent_stop"
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
  | "metadata_updated";

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
  parent_event_id?: string;
}

export interface ContextItem {
  key: string;
  label: string;
  content: any;
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
  parent_event_id?: string;
}

export interface DebugEvent {
  type: "debug";
  message: string;
}

export interface CompleteEvent {
  type: "complete";
  result: string;
  attachments: string[];
  claude_session_id?: string;
  /** 부모 이벤트 ID (Phase 2: 순수 parent 기반 배치용) */
  parent_event_id?: string;
}

export interface ErrorEvent {
  type: "error";
  message: string;
  error_code?: string;
  /** 부모 이벤트 ID (Phase 2: 순수 parent 기반 배치용) */
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
  parent_event_id?: string;
}

// === 세분화 SSE Events (대시보드 전용) ===

/** Extended Thinking 이벤트 */
export interface ThinkingEvent {
  type: "thinking";
  timestamp: number;
  thinking: string;
  signature?: string;
  /** 부모 이벤트 ID (서브에이전트 내부 노드 배치용) */
  parent_event_id?: string;
}

export interface TextStartEvent {
  type: "text_start";
  timestamp: number;
  /** 부모 이벤트 ID (서브에이전트 내부 노드 배치용) */
  parent_event_id?: string;
}

export interface TextDeltaEvent {
  type: "text_delta";
  timestamp: number;
  text: string;
  /** 부모 이벤트 ID (서브에이전트 내부 노드 배치용) */
  parent_event_id?: string;
}

export interface TextEndEvent {
  type: "text_end";
  timestamp: number;
  /** 부모 이벤트 ID (서브에이전트 내부 노드 배치용) */
  parent_event_id?: string;
}

export interface ToolStartEvent {
  type: "tool_start";
  timestamp: number;
  tool_name: string;
  tool_input: Record<string, unknown>;
  /** SDK ToolUseBlock ID (tool_result 매칭용) */
  tool_use_id?: string;
  /** 부모 이벤트 ID (서브에이전트 내부 노드 배치용) */
  parent_event_id?: string;
}

export interface ToolResultEvent {
  type: "tool_result";
  timestamp: number;
  tool_name: string;
  result: string;
  is_error: boolean;
  /** SDK ToolUseBlock ID (tool_start 매칭용) */
  tool_use_id?: string;
  /** 부모 이벤트 ID (서브에이전트 내부 노드 배치용) */
  parent_event_id?: string;
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
  /** 부모 이벤트 ID (서브에이전트 내부 노드 배치용) */
  parent_event_id?: string;
}

/** 서브에이전트 시작 이벤트 */
export interface SubagentStartEvent {
  type: "subagent_start";
  timestamp: number;
  agent_id: string;
  agent_type: string;
  parent_event_id: string;
}

/** 서브에이전트 종료 이벤트 */
export interface SubagentStopEvent {
  type: "subagent_stop";
  timestamp: number;
  agent_id: string;
  parent_event_id?: string;
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
  parent_event_id?: string;
  timestamp: number;
}

/** 사용자 입력 요청 응답 완료 이벤트 — 클라이언트가 선택 창을 닫아야 함 */
export interface InputRequestRespondedEvent {
  type: "input_request_responded";
  request_id: string;
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
  parent_event_id?: string;
}

/** Soul에서 수신하는 모든 SSE 이벤트 유니온 */
export type SoulSSEEvent =
  | ProgressEvent
  | MemoryEvent
  | SessionEvent
  | InterventionSentEvent
  | UserMessageEvent
  | DebugEvent
  | CompleteEvent
  | ErrorEvent
  | ContextUsageEvent
  | CompactEvent
  | ThinkingEvent
  | TextStartEvent
  | TextDeltaEvent
  | TextEndEvent
  | ToolStartEvent
  | ToolResultEvent
  | ResultEvent
  | SubagentStartEvent
  | SubagentStopEvent
  | ReconnectEvent
  | InputRequestEvent
  | InputRequestExpiredEvent
  | InputRequestRespondedEvent
  | HistorySyncEvent
  | AssistantMessageEvent;

// === JSONL Record ===

/** EventStore JSONL 레코드 형식 (파일의 한 줄) */
export interface EventRecord {
  id: number;
  event: Record<string, unknown>;
}

// === Session ===

/** 세션 상태 */
export type SessionStatus = "running" | "completed" | "error" | "interrupted" | "unknown";

/** LLM 토큰 사용량 */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

/** 세션의 마지막 readable-event 메시지 */
export interface LastMessage {
  type: string;
  preview: string;
  timestamp: string;
}

/** 세션 메타데이터 엔트리 */
export interface MetadataEntry {
  type: string;
  value: string;
  label?: string;
  url?: string;
  timestamp?: string;
  tool_name?: string;
}

/** 세션 요약 정보 (목록 조회용) */
export interface SessionSummary {
  /** 세션의 유일한 키. JSONL 파일명. */
  agentSessionId: string;
  status: SessionStatus;
  eventCount: number;
  lastEventType?: string;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string;
  /** 첫 user_message의 텍스트 (세션 목록에서 표시용) */
  prompt?: string;
  /** 세션 유형: Claude Code 세션 또는 LLM 세션 */
  sessionType?: "claude" | "llm";
  /** LLM 프로바이더 (openai, anthropic 등) */
  llmProvider?: string;
  /** LLM 모델명 */
  llmModel?: string;
  /** LLM 토큰 사용량 */
  llmUsage?: LlmUsage;
  /** LLM 클라이언트 식별자 */
  clientId?: string;
  /** 마지막 readable-event의 메시지 정보 */
  lastMessage?: LastMessage;
  /** 카탈로그에서 설정한 세션 표시 이름 */
  displayName?: string;
  /** 세션 메타데이터 (커밋, 브랜치, 카드 등 산출물 기록) */
  metadata?: MetadataEntry[];
  /** 마지막 이벤트 ID (읽음 상태 비교용) */
  lastEventId?: number;
  /** 마지막으로 읽은 이벤트 ID */
  lastReadEventId?: number;
  /** 세션을 생성한 노드 ID */
  nodeId?: string;
}

/** 세션 상세 정보 */
export interface SessionDetail extends SessionSummary {
  claudeSessionId?: string;
  result?: string;
  error?: string;
  events: EventRecord[];
}

// === Event Tree ===

/** 트리 노드 타입 (SSE 이벤트 lifecycle → 단일 노드) */
export type EventTreeNodeType = EventTreeNode["type"];

// === EventTreeNode Discriminated Union ===

/** 모든 노드 타입의 공통 필드 */
interface BaseNode {
  id: string;
  children: EventTreeNode[];
  content: string;
  completed: boolean;
  /** 부모 이벤트 ID (서브에이전트 내부 노드 배치용) */
  parentEventId?: string;
  /** 이벤트 발행 시각 (Unix epoch, 초) */
  timestamp?: number;
}

/** 가상 세션 루트 노드 */
export interface SessionNode extends BaseNode {
  type: "session";
  sessionId?: string;
  pid?: number;
  /** 세션 유형 */
  sessionType?: "claude" | "llm";
  /** LLM 프로바이더 */
  llmProvider?: string;
  /** LLM 모델명 */
  llmModel?: string;
}

/** 사용자 메시지 노드 */
export interface UserMessageNode extends BaseNode {
  type: "user_message";
  user: string;
  context?: ContextItem[];
}

/** 인터벤션 노드 */
export interface InterventionNode extends BaseNode {
  type: "intervention";
  user?: string;
}

/** Thinking (확장 사고) 노드 */
export interface ThinkingNode extends BaseNode {
  type: "thinking";
  /** 콘텐츠가 truncate 되었는지 여부 */
  isTruncated?: boolean;
  /** truncate된 경우, 전체 내용을 가진 원본 이벤트 ID */
  fullContentEventId?: number;
}

/** 텍스트 노드 */
export interface TextNode extends BaseNode {
  type: "text";
  /** text_end 수신 여부 */
  textCompleted?: boolean;
}

/** 도구 호출 노드 */
export interface ToolNode extends BaseNode {
  type: "tool" | "tool_use";
  /** SDK ToolUseBlock.id (tool_result 매칭용) */
  toolUseId?: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResult?: string;
  isError?: boolean;
  durationMs?: number;
  /** 콘텐츠가 truncate 되었는지 여부 */
  isTruncated?: boolean;
  /** truncate된 경우, 전체 내용을 가진 원본 이벤트 ID */
  fullContentEventId?: number;
}

/** 세션 결과 노드 */
export interface ResultNode extends BaseNode {
  type: "result";
  durationMs?: number;
  usage?: { input_tokens: number; output_tokens: number };
  totalCostUsd?: number;
}

/** 컨텍스트 압축 노드 */
export interface CompactNode extends BaseNode {
  type: "compact";
}

/** 세션 완료 노드 */
export interface CompleteNode extends BaseNode {
  type: "complete";
}

/** 에러 노드 */
export interface ErrorNode extends BaseNode {
  type: "error";
  isError?: boolean;
}

/** 사용자 입력 요청 노드 */
export interface InputRequestNodeDef extends BaseNode {
  type: "input_request";
  requestId: string;
  toolUseId?: string;
  questions: InputRequestQuestion[];
  responded?: boolean;
  expired?: boolean;
  receivedAt?: number;
  timeoutSec?: number;
  serverExpiredAt?: number;  // 서버 만료 이벤트 수신 시각 (ms) — expired=true 즉시 설정 방지용
}

/** LLM 프록시 어시스턴트 응답 노드 */
export interface AssistantMessageNode extends BaseNode {
  type: "assistant_message";
  model?: string;
  provider?: string;
  usage?: { input_tokens: number; output_tokens: number };
}

/** 이벤트 트리 노드 — 소스 오브 트루스 (discriminated union) */
export type EventTreeNode =
  | SessionNode
  | UserMessageNode
  | InterventionNode
  | ThinkingNode
  | TextNode
  | ToolNode
  | ResultNode
  | CompactNode
  | CompleteNode
  | ErrorNode
  | InputRequestNodeDef
  | AssistantMessageNode;

// === API Request/Response ===

/** POST /api/sessions 요청 (대시보드에서 세션 생성 또는 resume) */
export interface CreateSessionRequest {
  prompt: string;
  /** resume 시 기존 세션 ID. 없으면 새 세션 생성 (Soul 서버가 ID 생성). */
  agentSessionId?: string;
  /** 세션을 배치할 폴더 ID. 미지정 시 session_type 기반 자동 배정. */
  folderId?: string;
}

/** POST /api/sessions 응답 */
export interface CreateSessionResponse {
  agentSessionId: string;
  status: "running";
}

/** POST /api/sessions/:id/intervene 요청 */
export interface SendMessageRequest {
  text: string;
  user: string;
  attachmentPaths?: string[];
}

/** POST /api/sessions/:id/intervene 응답 */
export interface InterveneResponse {
  queued?: boolean;
  queue_position?: number;
  auto_resumed?: boolean;
  agent_session_id?: string;
}

/** POST /api/sessions/:id/respond 요청 */
export interface SendRespondRequest {
  requestId: string;
  answers: Record<string, string>;
}

/** POST /api/sessions/:id/respond 응답 */
export interface RespondResponse {
  status: string;
}

/** GET /api/sessions 응답 */
export interface SessionListResponse {
  sessions: SessionSummary[];
  total: number;
}

/** 공통 API 에러 응답 */
export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

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

// === Session Stream SSE Events ===

/**
 * 세션 스트림 SSE 이벤트 - /sessions/stream에서 전송
 *
 * 세션 목록의 실시간 변경사항을 클라이언트에 푸시합니다.
 */

/** 세션 목록 초기화 (구독 시 최초 전송) */
export interface SessionListStreamEvent {
  type: "session_list";
  sessions: SessionSummary[];
  total: number;
}

/** 새 세션 생성 */
export interface SessionCreatedStreamEvent {
  type: "session_created";
  session: SessionSummary;
}

/** 세션 상태 업데이트 */
export interface SessionUpdatedStreamEvent {
  type: "session_updated";
  agent_session_id: string;
  status: SessionStatus;
  updated_at: string;
  last_message?: LastMessage;
  last_event_id?: number;
  last_read_event_id?: number;
}

/** 세션 삭제 */
export interface SessionDeletedStreamEvent {
  type: "session_deleted";
  agent_session_id: string;
}

/** 카탈로그 폴더 */
export interface CatalogFolder {
  id: string;
  name: string;
  sortOrder: number;
}

/** 카탈로그 세션 배치 정보 */
export interface CatalogAssignment {
  folderId: string | null;
  displayName: string | null;
}

/** 카탈로그 상태 */
export interface CatalogState {
  folders: CatalogFolder[];
  sessions: Record<string, CatalogAssignment>;
}

/** 카탈로그 업데이트 이벤트 */
export interface CatalogUpdatedStreamEvent {
  type: "catalog_updated";
  catalog: CatalogState;
}

/** 메타데이터 업데이트 이벤트 (세션 스트림) */
export interface MetadataUpdatedStreamEvent {
  type: "metadata_updated";
  session_id: string;
  entry: MetadataEntry;
  metadata: MetadataEntry[];
}

/** 세션 스트림 이벤트 유니온 */
export type SessionStreamEvent =
  | SessionListStreamEvent
  | SessionCreatedStreamEvent
  | SessionUpdatedStreamEvent
  | SessionDeletedStreamEvent
  | CatalogUpdatedStreamEvent
  | MetadataUpdatedStreamEvent;
