// /api/sessions `sessionList[]` 정본 (Phase A-bis, 2026-05-16).
// orch-server `_session_to_response()`가 모든 키를 camelCase로 직렬화한다.
// snake_case 잔재가 있는 SSE wire(`session_created.session` to_session_info,
// `session_updated` payload)는 mappers.ts의 toSession/applySessionUpdates가
// 정규화하여 본 타입으로 변환한다 — 클라이언트 store는 항상 camelCase 단일 정본.
//
// 비교: `packages/soul-ui/src/shared/types.ts:SessionSummary`. soul-app은
// llmProvider/llmModel/llmUsage 같은 web 전용 필드를 두지 않는다 (앱이 llm
// 세션 채팅 UI 미지원). 필요 시 후속에서 확장.
export type ReviewState = 'not_required' | 'needs_review' | 'acknowledged';

// Server-owned v2 feed wire: contract 0ff47de3, producer 7caf0414. 앱은 소비만 하며
// server contract/fixture의 필드명과 enum을 임의로 확장하지 않는다.
export type PendingAttentionKind =
  | 'input_request'
  | 'permission'
  | 'tool_approval'
  | 'exit_plan_mode';

export interface PendingAttention {
  id: string;
  sourceEventId: number;
  sessionId: string;
  kind: PendingAttentionKind;
  requestedAt: string;
  title: string;
  body: string;
  requestId?: string;
  approvalId?: string;
  toolUseId?: string;
  toolName?: string;
  questions?: readonly Record<string, unknown>[];
  toolInput?: Readonly<Record<string, unknown>>;
  timeoutSec?: number;
  expiresAt?: string;
  requiresDetail: boolean;
}

export interface PendingAttentionDeltaEntry {
  revision: number;
  value: PendingAttention | null;
}

export type PendingAttentionsDelta = Readonly<
  Record<string, PendingAttentionDeltaEntry>
>;

export interface LiveTextSnapshotStream {
  streamIdentity: string;
  text: string | null;
  updatedAt: string;
  truncated: boolean;
  resetRequired: boolean;
  recovery: 'none' | 'durable_final';
}

export interface LiveTextSnapshotWire {
  type: 'text_snapshot';
  basedOnEventId: number;
  throughLiveSeq: number;
  streams: readonly LiveTextSnapshotStream[];
}

export interface LiveTextEventMetadata {
  streamIdentity: string;
  liveSeq: number;
  liveTextMode: 'replace' | 'append';
}

export interface Session {
  cardId?: string | null;
  /** server: agent_session_id. 세션의 정본 식별자. */
  agentSessionId: string;
  /** 표시명. null/미지정 시 last_message.preview 또는 "제목 없는 세션" fallback. */
  displayName: string | null;
  // 서버는 'unknown' 등 미지의 상태값도 보낼 수 있어 string 유니온을 풀어둔다.
  // 시각화는 STATUS_COLORS 매핑 + 폴백(`#888`)으로 안전 처리됨 (ChatScreen.tsx).
  status: string;
  /** 서버 세션 이벤트의 최신 정본 좌표. 교차 스트림 lifecycle 순서 판정에 사용한다. */
  lastEventId?: number;
  /**
   * Compact feed change watermark in the same raw event-id coordinate.
   * undefined is an old-server omission; null is explicit legacy unknown.
   */
  feedLastEventId?: number | null;
  /** 서버가 기록한 마지막 lifecycle 전이 사유. */
  terminationReason?: string | null;
  /** lifecycle 전이의 선택적 상세 정보. */
  terminationDetail?: string | null;
  /** 실행 상태와 독립된 검수 대상 여부. old server 응답은 mapper에서 false로 정규화. */
  reviewRequired?: boolean;
  /** 실행 상태와 독립된 검수 상태. old server 응답은 not_required로 정규화. */
  reviewState?: ReviewState;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  eventCount?: number;
  folderId?: string | null;
  // /api/sessions sessionList 항목에 포함되는 추가 메타. 화면 렌더에 직접 쓰이지 않더라도
  // setSessions에 들어오는 객체를 손실 없이 보존하기 위해 선택 필드로 받는다.
  nodeId?: string;
  lastMessage?: {
    type?: string;
    /** 신규 projection write의 event order tie-break. 구서버 snapshot은 생략 가능. */
    eventId?: number;
    preview?: string;
    timestamp?: string;
  } | null;
  /** Compact feed snapshot. Live mutations arrive as pending_attentions_delta. */
  pendingAttentions?: readonly PendingAttention[];
  attentionRevision?: number;
  sessionType?: string;
  prompt?: string | null;
  agentId?: string | null;
  // /api/sessions sessionList의 추가 필드. 피드/세션 카드 좌측 아바타 렌더링에 사용된다.
  agentName?: string | null;
  // 서버 발급 상대 경로 (`/api/nodes/{nodeId}/agents/{agentId}/portrait`).
  // 클라이언트는 serverUrl을 prepend하고 JWT를 Authorization 헤더에 실어 Image로 로드.
  agentPortraitUrl?: string | null;
  // agent backend ("claude" | "codex" | ...). 검색 필터·음성 제어와
  // modelLabel 미수신 기간의 카드 폴백에 사용한다.
  backend?: string | null;
  /** 서버 model preset id. 세션 생성·승계의 선택 정본. */
  modelPreset?: string | null;
  /** Effort the session was created with. Null means backend default. */
  reasoningEffort?: string | null;
  /** 서버 model-catalog가 정한 표시 라벨. 예: "Claude - Opus". */
  modelLabel?: string | null;
  // 사용자(노드 소유자) 이름 — 채팅의 우측 user 메시지 아바타 폴백 표시에 사용.
  userName?: string | null;
  // 사용자 portrait 상대경로 — `/api/nodes/{nodeId}/users/portrait` 등.
  userPortraitUrl?: string | null;
  // 위임 세션의 부모(caller) 세션 ID — 다른 에이전트가 `delegate-task` MCP로 만든
  // 세션에서만 채워진다. 직접 진입(브라우저/슬랙/외부 API/소울앱)은 null.
  // 정본은 sessions.caller_session_id 컬럼 (orch-server `session_serializer.py`).
  // SessionCard가 위임 세션의 caller agent 보조 행 표시 게이트로 사용한다.
  callerSessionId?: string | null;
}

export interface SessionEndedReconciliation {
  status: string;
  lastEventId: number;
  terminationReason?: string | null;
  terminationDetail?: string | null;
}

// 서버의 CatalogFolder 타입 기반
export interface Folder {
  id: string;
  name: string;
  sortOrder: number;
  status?: 'open' | 'completed';
  version?: number;
  archived?: boolean;
  projectPageId?: string | null;
  parentFolderId?: string | null;
  settings?: {
    excludeFromFeed?: boolean;
    excludeFromNotification?: boolean;
    folderPrompt?: string;
    atomContextNode?: {
      nodeId: string;
      nodeTitle?: string;
      depth?: number;
      titlesOnly?: boolean;
    } | null;
  };
  createdAt?: string;
  updatedAt?: string;
}

export type CatalogFolder = Folder & {
  parentFolderId: string | null;
  projectPageId: string | null;
  settings: NonNullable<Folder['settings']>;
  archived: boolean;
  status: 'open' | 'completed';
  version: number;
};

export interface FolderMutationResult {
  folder: CatalogFolder;
  operation: { id: string; folderId: string; operationType: string };
  idempotent: boolean;
}

export interface CatalogAssignment {
  folderId: string | null;
  displayName: string | null;
}

export type CatalogSessionsDelta = Record<string, CatalogAssignment | null>;

// 서버의 CatalogState 타입 기반
export interface Catalog {
  folders: Folder[];
  sessions: Record<string, CatalogAssignment>;
}

export interface SessionListResponse {
  total: number;
  sessions: Session[];
  offset: number;
  limit: number;
}

/** POST /api/sessions/:id/intervene 응답. */
export interface InterveneResponse {
  delivered?: boolean | null;
  outcome?:
    | 'delivered'
    | 'queued'
    | 'auto_resumed'
    | 'deferred'
    | 'suppressed'
    | 'unknown';
  reason?: string;
  consumeWhen?: 'next_turn' | null;
  queued?: boolean;
  queue_position?: number;
  auto_resumed?: boolean;
  agent_session_id?: string;
  /** 서버가 실제로 반환한 경우에만 UI 사용 로그의 compose_result와 연결한다. */
  sessionEventId?: string | number;
}

// SSE event types — soul-dashboard SSE_EVENT_TYPES 기반
export type SessionEventType =
  | 'text_start'
  | 'text_delta'
  | 'text_end'
  | 'tool_start'
  | 'tool_result'
  | 'thinking_start'
  | 'thinking_delta'
  | 'thinking_end'
  | 'user_message'
  | 'assistant_message'
  | 'turn_summary'
  | 'debug'
  | 'intervention_sent'
  | 'session_notification'
  | 'system'
  | 'session_start'
  | 'session_ended'
  | 'complete'
  | 'result'
  | 'context_usage'
  | 'compact'
  | 'error'
  | 'input_request'
  | 'input_request_expired'
  | 'input_request_responded'
  | 'agent_updated'
  | 'handoff_requested'
  | 'handoff_occurred'
  | 'tool_approval_requested'
  | 'tool_approval_resolved'
  | 'guardrail_tripwire'
  | 'realtime_status'
  | 'realtime_transcript'
  | 'claude_runtime_session_state'
  | 'claude_runtime_task_started'
  | 'claude_runtime_task_created'
  | 'claude_runtime_task_updated'
  | 'claude_runtime_task_progress'
  | 'claude_runtime_task_completed'
  | 'claude_runtime_task_notification'
  | 'claude_runtime_notification'
  | 'claude_runtime_remote_trigger'
  | 'claude_runtime_transcript_mirror_error'
  | 'claude_runtime_hook_event'
  | 'claude_runtime_mode_state'
  | 'claude_runtime_schedule_updated'
  | 'claude_runtime_schedule_deleted'
  | 'text_snapshot'
  | 'history_sync';

export interface SessionEvent {
  id: string; // SSE id 필드 — lastEventId로 사용
  type: SessionEventType; // SSE event 필드 (최상위 타입)
  data: Record<string, unknown>; // SSE data JSON 파싱 결과
}

export interface ClaudeRuntimeSessionStatePayload {
  type: 'claude_runtime_session_state';
  state: 'idle' | 'running' | 'requires_action';
  session_id?: string;
  timestamp?: number;
}

export interface ClaudeRuntimeTaskStartedPayload {
  type: 'claude_runtime_task_started';
  task_id: string;
  session_id?: string;
  tool_use_id?: string;
  description?: string;
  task_type?: string;
  workflow_name?: string;
  prompt?: string;
  skip_transcript?: boolean;
  timestamp?: number;
}

export interface ClaudeRuntimeTaskCreatedPayload {
  type: 'claude_runtime_task_created';
  task_id: string;
  session_id?: string;
  subject: string;
  description?: string;
  teammate_name?: string;
  team_name?: string;
  timestamp?: number;
}

export interface ClaudeRuntimeTaskUpdatedPayload {
  type: 'claude_runtime_task_updated';
  task_id: string;
  session_id?: string;
  patch: {
    status?: 'pending' | 'running' | 'completed' | 'failed' | 'stopped' | 'killed';
    description?: string;
    end_time?: number;
    total_paused_ms?: number;
    error?: string;
    is_backgrounded?: boolean;
    [key: string]: unknown;
  };
  timestamp?: number;
}

export interface ClaudeRuntimeTaskProgressPayload {
  type: 'claude_runtime_task_progress';
  task_id: string;
  session_id?: string;
  tool_use_id?: string;
  description?: string;
  usage?: Record<string, unknown>;
  last_tool_name?: string;
  summary?: string;
  timestamp?: number;
}

export interface ClaudeRuntimeTaskCompletedPayload {
  type: 'claude_runtime_task_completed';
  task_id: string;
  session_id?: string;
  subject: string;
  description?: string;
  teammate_name?: string;
  team_name?: string;
  timestamp?: number;
}

export interface ClaudeRuntimeTaskNotificationPayload {
  type: 'claude_runtime_task_notification';
  task_id: string;
  status: 'completed' | 'failed' | 'stopped';
  session_id?: string;
  tool_use_id?: string;
  output_file?: string;
  summary?: string;
  usage?: Record<string, unknown>;
  skip_transcript?: boolean;
  timestamp?: number;
}

export interface SessionNotificationPayload {
  type: 'session_notification';
  delivery_id: string;
  delivery_intent: 'completion_notification' | 'runtime_followup';
  source: string;
  text: string;
  disposition: 'queued' | 'auto_resume';
  completion_id?: string;
  relation_key?: string;
  rate_limit_type?: string;
  resets_at?: string;
  timestamp?: number;
}

export interface ClaudeRuntimeNotificationPayload {
  type: 'claude_runtime_notification';
  notification_id: string;
  source: 'hook' | 'system' | 'tool_use';
  message: string;
  title?: string;
  notification_type?: string;
  key?: string;
  priority?: string;
  session_id?: string;
  tool_use_id?: string;
  timestamp?: number;
}

export interface ClaudeRuntimeRemoteTriggerPayload {
  type: 'claude_runtime_remote_trigger';
  trigger_id: string;
  source: 'message_origin' | 'tool_use';
  session_id?: string;
  tool_use_id?: string;
  origin_kind?: string;
  origin_from?: string;
  origin_name?: string;
  origin_server?: string;
  priority?: string;
  prompt?: string;
  trigger_type?: string;
  payload?: Record<string, unknown>;
  timestamp?: number;
}

export interface ClaudeRuntimeTranscriptMirrorErrorPayload {
  type: 'claude_runtime_transcript_mirror_error';
  mirror_id: string;
  session_id?: string;
  project_key: string;
  transcript_session_id: string;
  subpath?: string;
  error: string;
  timestamp?: number;
}

export interface ClaudeRuntimeHookPayload {
  type: 'claude_runtime_hook_event';
  hook_event_name: string;
  session_id?: string;
  tool_name?: string;
  tool_use_id?: string;
  hook_input?: Record<string, unknown>;
  timestamp?: number;
}

export interface ClaudeRuntimeModeStatePayload {
  type: 'claude_runtime_mode_state';
  mode: 'plan' | 'worktree';
  active: boolean;
  source: 'hook' | 'tool_use';
  session_id?: string;
  tool_name?: string;
  tool_use_id?: string;
  worktree_name?: string;
  worktree_path?: string;
  worktree_action?: string;
  timestamp?: number;
}

export type ClaudeRuntimeScheduleKind = 'wakeup' | 'cron';

export type ClaudeRuntimeScheduleStatus =
  | 'active'
  | 'dispatching'
  | 'firing'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'orphaned';

export interface ClaudeRuntimeSchedule {
  scheduleId: string;
  sessionId?: string;
  kind: ClaudeRuntimeScheduleKind;
  status: ClaudeRuntimeScheduleStatus;
  prompt?: string;
  sourceTool?: string;
  toolUseId?: string | null;
  cronExpression?: string | null;
  runOnceAt?: string | null;
  timezone?: string;
  recurring?: boolean;
  nextRunAt?: string | null;
  lastFiredAt?: string | null;
  firedCount?: number;
  lastError?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export type ClaudeRuntimeTaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'killed';

export interface ClaudeRuntimeTask {
  taskId: string;
  status: ClaudeRuntimeTaskStatus;
  updatedAt: number;
  sessionId?: string;
  toolUseId?: string;
  description?: string;
  taskType?: string;
  workflowName?: string;
  subject?: string;
  teammateName?: string;
  teamName?: string;
  prompt?: string;
  skipTranscript?: boolean;
  outputFile?: string;
  summary?: string;
  usage?: Record<string, unknown>;
  lastToolName?: string;
  error?: string;
  isBackgrounded?: boolean;
  endTime?: number;
  totalPausedMs?: number;
}

export interface ClaudeRuntimeNotification {
  notificationId: string;
  source: 'hook' | 'system' | 'tool_use';
  message: string;
  updatedAt: number;
  title?: string;
  notificationType?: string;
  key?: string;
  priority?: string;
  sessionId?: string;
  toolUseId?: string;
}

export interface ClaudeRuntimeRemoteTrigger {
  triggerId: string;
  source: 'message_origin' | 'tool_use';
  updatedAt: number;
  sessionId?: string;
  toolUseId?: string;
  originKind?: string;
  originFrom?: string;
  originName?: string;
  originServer?: string;
  priority?: string;
  prompt?: string;
  triggerType?: string;
  payload?: Record<string, unknown>;
}

export interface ClaudeRuntimeTranscriptMirror {
  updatedAt: number;
  errorCount: number;
  lastError?: string;
  mirrorId?: string;
  sessionId?: string;
  projectKey?: string;
  transcriptSessionId?: string;
  subpath?: string;
}

export interface ClaudeRuntimeMode {
  active: boolean;
  updatedAt: number;
  source?: 'hook' | 'tool_use';
  toolUseId?: string;
  toolName?: string;
  worktreeName?: string;
  worktreePath?: string;
  worktreeAction?: string;
}

export interface ClaudeRuntimeTasksResponse {
  sessionId: string;
  sessionState: 'idle' | 'running' | 'requires_action' | null;
  runtimeSessionId: string | null;
  updatedAt: number | null;
  tasks: ClaudeRuntimeTask[];
  notifications?: ClaudeRuntimeNotification[];
  remoteTriggers?: ClaudeRuntimeRemoteTrigger[];
  transcriptMirror?: ClaudeRuntimeTranscriptMirror | null;
  planMode?: ClaudeRuntimeMode | null;
  worktreeMode?: ClaudeRuntimeMode | null;
}

export interface ClaudeRuntimeTaskOutputResponse {
  sessionId: string;
  taskId: string;
  task: ClaudeRuntimeTask | null;
  output: string;
  outputAvailable: boolean;
  truncated: boolean;
  message?: string;
}

export interface ClaudeRuntimeStopTaskResponse {
  sessionId: string;
  taskId: string;
  supported: boolean;
  stopped: boolean;
  alreadyTerminal: boolean;
  status?: string;
  message?: string;
  task: ClaudeRuntimeTask | null;
}

export interface ClaudeRuntimeSchedulesResponse {
  sessionId: string;
  nextRunAt: string | null;
  schedules: ClaudeRuntimeSchedule[];
}

export interface ClaudeRuntimeDeleteScheduleResponse {
  sessionId: string;
  scheduleId: string;
  status: string;
  deleted: boolean;
  schedule: ClaudeRuntimeSchedule | null;
}

// AskQuestion (input_request) SSE 페이로드 타입
// 이벤트 envelope은 snake_case지만 Claude AskUserQuestion의 questions 입력은 SDK 원형
// (multiSelect, preview)을 그대로 통과한다.
export interface InputRequestOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface InputRequestQuestion {
  question: string;
  header?: string;
  options: InputRequestOption[];
  multiSelect?: boolean;
}

export interface InputRequestPayload {
  request_id: string;
  tool_use_id?: string;
  questions: InputRequestQuestion[];
  // wire 호환성으로 보존. soul-app은 평면 모델(chatStore.ts mergeSorted + ChatBody.tsx
  // groupChatEvents)이라 parent_event_id를 트리 구성에 사용하지 않는다.
  // soulstream Phase 2-A 평탄화(atom 260507.01)로 web 클라이언트도 같은 정책으로 통일.
  parent_event_id?: number | null;
  started_at: number;   // Unix epoch sec — 클라이언트에서 * 1000으로 ms 변환
  timeout_sec: number;  // 보통 300
}

export interface InputRequestStatusPayload {
  request_id: string;
  // wire 호환성으로 보존. FE 평면 모델에서는 사용하지 않는다 (위 InputRequestPayload 주석 참조).
  parent_event_id?: number | null;
}

export interface ToolApprovalPayload {
  approval_id?: string;
  approvalId?: string;
  tool_name?: string;
  toolName?: string;
  agent_name?: string;
  agentName?: string;
  arguments?: unknown;
  realtime?: boolean;
  call_id?: string;
  callId?: string;
  timestamp?: number;
}

export interface ToolApprovalResolvedPayload {
  approval_id?: string;
  approvalId?: string;
  decision?: 'approved' | 'rejected';
  realtime?: boolean;
  source?: 'tap' | 'voice';
  call_id?: string;
  callId?: string;
}

export interface RealtimeStatusPayload {
  status: string;
  call_id?: string;
  callId?: string;
  message?: string;
  raw_event_type?: string;
  timestamp?: number;
}

export interface RealtimeTranscriptPayload {
  role: 'user' | 'assistant';
  text: string;
  final?: boolean;
  call_id?: string;
  callId?: string;
  item_id?: string;
  timestamp?: number;
}
