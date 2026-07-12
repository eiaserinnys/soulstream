/**
 * Task 모델 — Codex 전담 흐름 (Phase B-3 기본 + B-4 resume/intervention).
 *
 * Python `service/task_models.py::Task` 정본을 *참조*하되 *코드 복사 아님*
 * (4차 캐시 §7.3 시그니처 동등 의무 없음, atom d7a1ad86 정본 둘 안티패턴 회피).
 *
 * 본 PR에서 *사용*하지 않는 Python 필드는 의도적 미포함:
 *   - _deliver_input_response (TS는 EnginePort 선택 capability로 처리)
 *   - pending_folder_id (folder 배정은 B-4 후속 PR-B 범위)
 *
 * B-4 추가 필드 (분석 캐시 `20260517-1410-codex-ts-folder-resume-intervene.md` §D):
 *   - interventionQueue: live delivery 미지원/idle-race/terminal auto-resume에서 turn 사이
   *     큐잉되는 사용자 메시지. claude `task_models.py` intervention_queue(asyncio.Queue)
   *     정본의 fallback queue 의미와 동등.
 */

import type { ContextItem } from "../context/prompt_assembler.js";
import type {
  ClaudePermissionMode,
  EnginePort,
  QueuedToolApprovalDecision,
  ReasoningEffort,
} from "../engine/protocol.js";

/** task lifecycle 상태. Python `TaskStatus` enum과 값 일치 (DB sessions.status 컬럼 정본). */
export type TaskStatus = "running" | "completed" | "error" | "interrupted";

export type ReviewState = "not_required" | "needs_review" | "acknowledged";

export type TerminationReason =
  | "completed_ok"
  | "killed"
  | "limit_hit"
  | "error_aborted"
  | "unknown";

export type PendingTerminationHint = Exclude<
  TerminationReason,
  "completed_ok" | "unknown"
>;

/**
 * 사용자가 turn 사이에 보내는 개입 메시지. claude `task_manager.py:603-608`의 message dict와
 * *키 동등* (wire payload에 그대로 운반 가능).
 */
export interface InterventionMessage {
  text: string;
  user: string;
  callerInfo?: CallerInfo;
  attachmentPaths?: string[];
  /**
   * Internal runtime metadata. It is consumed by TaskExecutor follow-up guards and
   * intentionally not copied into intervention_sent/user_message wire payloads.
   */
  source?: string;
  followupAttempt?: number;
  followupKey?: string;
  /**
   * Phase A context 정본 (Y-10, atom d7a1ad86 정본 둘 안티패턴 차단):
   * intervention_sent 통합 후 wire에 박는 context_items 정본과 정합.
   */
  context?: ContextItem[];
}

/**
 * 발신자 정보. atom card `ed3a216d-2811-4792-bfbe-f15043c7faba` (caller_info 통합 스키마 v1) 정본.
 *
 * snake_case keys = wire 전달 시 그대로 운반 (orch broadcast wire 정합).
 */
export interface CallerInfo {
  source?: string | null;
  display_name?: string | null;
  avatar_url?: string | null;
  user_id?: string | null;
  agent_node?: string | null;
  agent_id?: string | null;
  agent_name?: string | null;
  [k: string]: unknown;
}

/** session_broadcaster.emit_session_message_updated의 last_message dict 정본. */
export interface LastMessage {
  type: string;
  preview: string;
  timestamp: string;
}

export type SessionType = "claude" | "llm";

export type ClaudeRuntimeSessionState = "idle" | "running" | "requires_action";

export type ClaudeRuntimeTaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "killed";

export interface ClaudeRuntimeTaskState {
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

export interface ClaudeRuntimeModeState {
  active: boolean;
  updatedAt: number;
  source?: "hook" | "tool_use";
  toolUseId?: string;
  toolName?: string;
  worktreeName?: string;
  worktreePath?: string;
  worktreeAction?: string;
}

export interface ClaudeRuntimeNotificationState {
  notificationId: string;
  source: "hook" | "system" | "tool_use";
  message: string;
  updatedAt: number;
  title?: string;
  notificationType?: string;
  key?: string;
  priority?: string;
  sessionId?: string;
  toolUseId?: string;
}

export interface ClaudeRuntimeRemoteTriggerState {
  triggerId: string;
  source: "message_origin" | "tool_use";
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

export interface ClaudeRuntimeTranscriptMirrorState {
  updatedAt: number;
  errorCount: number;
  lastError?: string;
  mirrorId?: string;
  sessionId?: string;
  projectKey?: string;
  transcriptSessionId?: string;
  subpath?: string;
}

/**
 * Claude Agent SDK runtime state. This is intentionally separate from
 * Soulstream's Task Tree model; SDK task ids live only under claudeRuntime.
 */
export interface ClaudeRuntimeState {
  sessionState?: ClaudeRuntimeSessionState;
  sessionId?: string;
  updatedAt: number;
  tasks: Record<string, ClaudeRuntimeTaskState>;
  notifications?: Record<string, ClaudeRuntimeNotificationState>;
  remoteTriggers?: Record<string, ClaudeRuntimeRemoteTriggerState>;
  transcriptMirror?: ClaudeRuntimeTranscriptMirrorState;
  planMode?: ClaudeRuntimeModeState;
  worktreeMode?: ClaudeRuntimeModeState;
}

/**
 * Task — Codex 세션 1개의 런타임 상태.
 *
 * 단일 turn 모델 (Codex 단일턴, B-3 범위) — 멀티턴은 B-4 검토.
 *
 * 영속화 책임: TaskManager가 `session_register` stored procedure로 *불변 필드* (agentSessionId,
 * nodeId, profileId, callerSessionId)만 박는다. 가변 필드(status, last_event_id 등)는
 * `session_update`로 진행 중 갱신.
 */
export interface Task {
  agentSessionId: string;
  prompt: string;
  status: TaskStatus;
  /** Orthogonal user review axis. Old in-memory test fixtures may omit it. */
  reviewRequired?: boolean;
  reviewState?: ReviewState;

  /** Agent registry 프로필 id (sessions.agent_id 컬럼). */
  profileId?: string;

  /** 외부 호출자 식별자. LLM proxy에서 `translate`, `recall` 등으로 사용. */
  clientId?: string | null;

  /** sessions.session_type 컬럼. Codex/Claude agent 세션은 "claude", LLM proxy는 "llm". */
  sessionType?: SessionType;

  /** LLM proxy 메타데이터. session_created wire에 포함된다. */
  llmProvider?: string | null;
  llmModel?: string | null;
  llmUsage?: Record<string, number> | null;

  /**
   * Codex SDK가 발급한 thread id. 첫 ThreadStartedEvent에서 어댑터가 채움.
   * sessions.claude_session_id 컬럼에 박힘 — Codex 백엔드라도 컬럼 의미가
   * "backend session id"로 일반화됨 (Phase A AgentProfile.backend 도입 정합).
   */
  codexThreadId?: string;

  callerSessionId?: string;
  callerInfo?: CallerInfo;
  /** false면 위임 완료 시 caller 세션 completion relay를 발화하지 않는다. 기본 true. */
  notifyCompletion?: boolean;
  /** sessions.metadata JSONB array와 session_created.session.metadata에 싣는 세션 메타데이터. */
  metadata?: Array<Record<string, unknown>>;

  /** OpenAI Agents SDK serialized RunState restored from sessions.metadata. */
  agentsRunState?: string;
  agentsRunStateSchemaVersion?: string;
  agentsPendingApprovalId?: string;
  agentsPreviousResponseId?: string;
  agentsConversationId?: string;
  /** OpenAI Agents SDK Session items restored from sessions.metadata. */
  agentsSessionItems?: unknown[];
  /** Approval decision delivered before a resumed Agents engine is back in memory. */
  agentsQueuedToolApproval?: QueuedToolApprovalDecision;

  /** 모델 override (Codex SDK ThreadOptions.model). */
  model?: string | null;
  /** Legacy per-task Claude OAuth token. Claude Code now resolves auth from its own config. */
  oauthToken?: string;
  /** 추론 모델 effort override. Codex는 ThreadOptions.modelReasoningEffort로 전달. */
  reasoningEffort?: ReasoningEffort;
  /** 요청별 허용 도구 override. 없으면 AgentProfile.allowed_tools를 사용. */
  allowedTools?: string[];
  /** 요청별 금지 도구 override. 없으면 AgentProfile.disallowed_tools를 사용. */
  disallowedTools?: string[];
  /** 요청별 MCP 사용 여부. 기본값 true. Claude는 SDK mcpServers 로딩 게이트로 사용. */
  useMcp?: boolean;
  /** 요청별 Claude Agent SDK permission mode override. 없으면 AgentProfile 정책을 사용. */
  claudePermissionMode?: ClaudePermissionMode;

  /** 첫 turn prompt와 user_message.context에 함께 박을 외부 context items. */
  contextItems?: ContextItem[];

  /** 첫 turn user_message.attachments와 engine image 입력 분리에 사용할 원본 첨부 경로. */
  attachmentPaths?: string[];

  /**
   * B-6 context_builder: 사용자/위임자가 지정한 system_prompt. Python `task_models.Task.system_prompt`
   * 정합. context_builder가 folder_prompt와 조합하여 codex 첫 turn prompt에 prepend.
   *
   * codex SDK 0.130.0은 turn-level systemPrompt 미지원이라 prompt 문자열 prepend로 처리
   * (분석 캐시 `20260517-2338-codex-ts-context-builder-B-6.md` §B).
   */
  systemPrompt?: string;

  createdAt: Date;
  completedAt?: Date;

  /** DB events.id 최신값. event_append 반환값으로 갱신. */
  lastEventId: number;
  lastReadEventId: number;

  /** session_updated wire에 박힘 — 최종 assistant_message 또는 live text 누적 결과. */
  lastAssistantText?: string;
  lastProgressText?: string;

  /** 정상 완료 시 결과 텍스트, 실패 시 error 메시지. */
  result?: string;
  error?: string;

  /** Supervisor Phase A: terminal reason is finalized once by TaskLifecycleTransition. */
  terminationReason?: TerminationReason;
  terminationDetail?: string | null;
  pendingTerminationHint?: PendingTerminationHint;
  pendingTerminationDetail?: string | null;
  terminationEventRecorded?: boolean;
  /** Supervisor usage normalization state. Runtime-only, never serialized to DB. */
  supervisorUsageTotals?: Record<string, number>;

  /** Claude Agent SDK 장기 실행 runtime 상태. Task Tree와 별도 정본이다. */
  claudeRuntime?: ClaudeRuntimeState;

  // === 런타임 전용 (DB·wire에 직접 박지 않음) ===

  /** 후속 턴에 claude_session_id delta를 한 번만 주입하기 위한 런타임 마커. */
  lastInjectedClaudeSessionId?: string;

  /** 후속 턴에 caller_info delta를 한 번만 주입하기 위한 런타임 마커. */
  lastInjectedCallerInfo?: CallerInfo;

  /** compact 직후 첫 사용자 메시지에서만 full context를 재주입하기 위한 런타임 플래그. */
  needsFullContextReinjection?: boolean;

  /** 진행 중 turn의 어댑터. cancelTask()에서 engine.interrupt() 호출 대상. */
  engine?: EnginePort;

  /** task_executor.startExecution 반환 promise. shutdown 시 await. */
  executionPromise?: Promise<void>;

  /** DB에서 복원된 task인지 여부. 실행 중 메모리 task와 구분할 때 사용. */
  hydratedFromDb?: boolean;

  /**
   * Turn 사이 큐잉되는 개입 메시지 (B-4, claude `task_manager.py:603-609`의 asyncio.Queue
   * 정본 fallback과 의미 동등). live delivery 미지원/idle-race/terminal auto-resume이면
   * turn 종료 후 dequeue → 다음 turn으로 자동 진입.
   *
   * 단일 process·단일 task_manager Map이라 별도 mutex 불요 — async await 경계만 정합.
   */
  interventionQueue: InterventionMessage[];

}
