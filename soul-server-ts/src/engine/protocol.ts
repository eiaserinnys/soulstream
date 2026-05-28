/**
 * EnginePort — 백엔드-중립 엔진 어댑터 interface.
 *
 * 옵션 D 비대칭 모델 단계 1 (Phase B-2): TS 노드는 Codex 백엔드 전담.
 * 본 interface는 *미래의 ClaudeEngineAdapter*도 만족할 수 있도록 backend 무관 시그니처.
 *
 * 호출자(task_executor 등, B-3)는 본 interface만 보고 backend를 모른다 — 분기 로직 없음.
 *
 * 참조:
 * - 2차 캐시 §11.3 Python EnginePort 시그니처 (개념 대칭)
 * - 4차 캐시 §7.2·§7.3 (TS Protocol 선택지 A — 단계 1부터 자리 두기)
 * - 분석 캐시 `20260517-1700-phase-b2-engine-port-codex.md` §2
 */

import type { SessionEventEnvelope } from "@soulstream/wire-schema";

/**
 * SSE wire에 발행되는 단위. wire-schema `SessionEventEnvelope.event` 필드의 union
 * (SSEEventInit | SSEEventComplete | SSEEventTextEnd | ... 28종).
 *
 * wire-schema가 단일 `SSEEvent` 타입을 export하지 않으므로 envelope에서 추출.
 * spec-reviewer 1차 P0 — 정정 후 정본.
 */
export type SSEEventPayload = SessionEventEnvelope["event"];

/**
 * 백엔드 식별자. 새 백엔드(예: gemini) 추가 시 본 type alias만 갱신.
 * spec-reviewer 1차 P2 — inline literal 대신 분리 (분산 수정 회피).
 */
export type BackendId = "claude" | "codex" | "openai-agents";

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

// === 콜백 시그니처 ===

/**
 * EnginePort.execute 도중 추가 SSE 발행 콜백.
 *
 * Python EnginePort는 EngineEvent 객체를 콜백으로 전달하지만, TS 정본은
 * SSEEventPayload 직접 발행으로 단순화 (4차 캐시 §7.3 시그니처 동등 의무 없음).
 * 본 PR의 어댑터는 yield AsyncIterable을 메인 경로로 사용하고 onEvent는 옵셔널 부가 출력.
 */
export type EventCallback = (payload: SSEEventPayload) => Promise<void>;

/** 진행 상태 메시지 콜백 (예: "thread starting", "turn completed"). */
export type ProgressCallback = (message: string) => Promise<void>;

/** 새 세션이 시작될 때 backend session id 전달. 호출자가 task에 영속. */
export type SessionCallback = (sessionId: string) => Promise<void>;

export interface EngineUserInput {
  prompt: string;
  imageAttachmentPaths?: string[];
}

export type InterventionInput = string | EngineUserInput;

/**
 * 사용자 개입 메시지 요청 콜백. 호출자가 즉시 보낼 메시지를 반환하거나 null.
 *
 * Codex SDK 0.130.0은 turn 도중 input 주입 표면 없음(d.ts 검증) — 본 PR 어댑터는
 * 조용히 무시하고 turn 끝에 새 prompt fallback. B-3에서 task lifecycle와 결합.
 */
export type InterventionCallback = () => Promise<InterventionInput | null>;

/**
 * compact 이벤트 콜백 (Claude 고유 `/compact`). Codex는 발행 안 함 — Codex 어댑터에서
 * 호출되지 않음(no-op). interface에는 *미래 백엔드*를 위해 자리 둠.
 */
export type CompactCallback = (sessionId: string, summary: string) => Promise<void>;

/** EnginePort.execute 파라미터. 위임자 §R1 시그니처 그대로. */
export interface EngineExecuteParams {
  prompt: string;
  /** Codex SDK `UserInput[]`로 전달할 로컬 이미지 첨부 경로. */
  imageAttachmentPaths?: string[];
  resumeSessionId?: string;
  model?: string | null;
  /** Codex SDK ThreadOptions.modelReasoningEffort. Missing defaults to xhigh at adapter boundary. */
  reasoningEffort?: ReasoningEffort;
  /**
   * 시스템 프롬프트. 백엔드별 지원 여부:
   * - Claude SDK: `ClaudeAgentOptions.system_prompt`로 직접 매핑.
   * - **Codex SDK 0.130.0**: ThreadOptions에 표면 없음 — `CodexOptions.config.base_instructions`
   *   인스턴스 단위로만 주입 가능. *turn-level systemPrompt 미지원*. Codex 어댑터는
   *   본 옵션을 받으면 warn 로깅 후 *무시*. 호출자(B-3)가 prompt에 prepend하거나
   *   어댑터 재생성 필요.
   */
  systemPrompt?: string;
  /**
   * agents.yaml의 `allowed_tools` — Claude SDK `ClaudeAgentOptions.allowedTools`로 forward.
   * Codex 어댑터는 무시 (Codex CLI에 turn-level 권한 표면 없음).
   */
  allowedTools?: string[];
  /** agents.yaml의 `disallowed_tools` — Claude SDK `disallowedTools`로 forward. Codex 무시. */
  disallowedTools?: string[];
  /** agents.yaml의 `max_turns` — Claude SDK `maxTurns`로 forward. Codex 무시. */
  maxTurns?: number;
  /** 요청별 MCP 사용 여부. Claude 어댑터는 false면 명시 mcpServers 로딩을 생략. Codex 무시. */
  useMcp?: boolean;
  extraEnv?: Record<string, string>;
  /** OpenAI Agents SDK serialized RunState. Backend-specific; other adapters ignore. */
  resumeRunState?: string;
  /** OpenAI Responses previous response id, restored with RunState/Session metadata. */
  previousResponseId?: string | null;
  /** OpenAI Conversations/Responses conversation id, restored with RunState/Session metadata. */
  conversationId?: string | null;
  /** OpenAI Agents SDK Session item history restored from Soulstream metadata. */
  sessionItems?: unknown[];
  /** Approval decision queued before the resumed SDK engine is back in memory. */
  queuedToolApproval?: QueuedToolApprovalDecision;
  onEvent?: EventCallback;
  onProgress?: ProgressCallback;
  onSession?: SessionCallback;
  /**
   * Legacy polling hook. TaskEngineTurnRunner must not pass this for Claude resumed turns.
   * Active-turn delivery uses SupportsLiveTurnSteering.steerActiveTurn instead.
   */
  onIntervention?: InterventionCallback;
  onCompact?: CompactCallback;
  onRunStateSnapshot?: RunStateSnapshotCallback;
  onSessionItemsSnapshot?: SessionItemsSnapshotCallback;
}

/**
 * 백엔드-중립 엔진 어댑터 interface.
 *
 * 구현: CodexEngineAdapter (Phase B-2). 미래에 ClaudeEngineAdapter (TS 백엔드 흡수 시).
 * 호출자는 본 interface만 보고 backend를 모른다.
 */
export interface EnginePort {
  /** 이 엔진이 동작할 작업 디렉토리. agent_registry.AgentProfile.workspace_dir에서 주입. */
  readonly workspaceDir: string;

  /** 진단·로깅용 — 분기 로직에 사용 금지. */
  readonly backendId: BackendId;

  /**
   * 한 turn 실행. AsyncIterable로 SSE payload 발행.
   *
   * **동시 호출 금지** — 한 어댑터 인스턴스당 한 번에 *하나의 turn*만. 진행 중 turn이 있을 때
   * `execute()` 재호출 시 구현체는 throw해야 한다 (Codex 어댑터는 명시 가드). 후속 turn을
   * 시작하려면 `interrupt()` 호출 후 직전 turn의 generator를 drain.
   *
   * - resumeSessionId 있으면 해당 세션 이어 실행. 없으면 새 thread/session 생성.
   * - 새 세션 시작 시 onSession 콜백으로 sessionId 통지 (호출자가 task에 영속).
   * - 첫 yield되는 SSEEvent는 보통 `session` 타입 (session_id 운반).
   * - onIntervention: legacy polling hook. Live input steering uses SupportsLiveTurnSteering.
   * - onCompact: Codex는 호출되지 않음 (no-op).
   */
  execute(params: EngineExecuteParams): AsyncIterable<SSEEventPayload>;

  /**
   * 실행 중 turn 중단. 성공 시 true.
   *
   * - Codex SDK: TurnOptions.signal (AbortController)로 처리.
   */
  interrupt(): Promise<boolean>;

  /**
   * 엔진 정리. context manager 외부에서 명시 호출 가능.
   * idempotent — 이미 닫혔으면 즉시 반환.
   */
  close(): Promise<void>;
}

// === 선택적 capability (정의만 — Codex 어댑터는 미구현) ===

/**
 * 백엔드가 conversation compaction을 지원하면 구현.
 *
 * Claude `/compact`처럼 long context를 요약해 새 세션으로 fork.
 * 호출자가 `"compact" in engine` 검사로 분기.
 */
export interface SupportsCompact {
  compact(sessionId: string): Promise<void>;
}

/**
 * 백엔드가 thread fork를 지원하면 구현.
 *
 * Codex의 향후 thread_fork API 도입 시 본 어댑터에서 구현. 본 PR 범위 외.
 */
export interface SupportsThreadFork {
  threadFork(sourceSessionId: string): Promise<string>;
}

/**
 * 백엔드가 실행 중 turn에 live user input steering을 지원하면 구현.
 *
 * Codex app-server generated schema 기준 `turn/steer`는 threadId + expectedTurnId로
 * 현재 active turn에 UserInput[]을 전달한다. 기존 exec adapter는 해당 표면이 없어
 * 구현하지 않으며, 호출자는 capability presence로만 판단한다.
 */
export type LiveTurnSteerStatus =
  | "delivered"
  | "not_supported"
  | "no_active_turn"
  | "turn_mismatch"
  | "failed";

export interface LiveTurnSteerResult {
  status: LiveTurnSteerStatus;
  message?: string;
}

export interface SupportsLiveTurnSteering {
  steerActiveTurn(
    input: EngineUserInput,
  ): Promise<LiveTurnSteerResult> | LiveTurnSteerResult;
}

/**
 * 백엔드가 turn 중 AskUserQuestion 같은 input request 응답 주입을 지원하면 구현.
 *
 * Codex SDK 0.130.0은 해당 표면이 없으므로 구현하지 않는다. 호출자는 capability
 * presence로만 판단하여 Codex 경로로 respond가 새지 않게 한다.
 */
export type InputResponseDeliveryStatus =
  | "delivered"
  | "expired"
  | "already_responded"
  | "request_not_pending"
  | "not_supported";

export interface InputResponseDeliveryResult {
  status: InputResponseDeliveryStatus;
  message?: string;
}

export interface SupportsInputResponse {
  deliverInputResponse(
    requestId: string,
    answers: Record<string, unknown>,
  ): Promise<InputResponseDeliveryResult> | InputResponseDeliveryResult;
}

export type ToolApprovalDecision = "approved" | "rejected";

export type ToolApprovalDeliveryStatus =
  | "delivered"
  | "approval_not_pending"
  | "already_resolved"
  | "not_supported";

export interface ToolApprovalDeliveryOptions {
  message?: string;
  alwaysApprove?: boolean;
  alwaysReject?: boolean;
}

export interface ToolApprovalDeliveryResult {
  status: ToolApprovalDeliveryStatus;
  message?: string;
}

export interface QueuedToolApprovalDecision {
  approvalId: string;
  decision: ToolApprovalDecision;
  options?: ToolApprovalDeliveryOptions;
}

export interface EngineRunStateSnapshot {
  backendId: BackendId;
  serialized: string | null;
  pendingApprovalId?: string | null;
  previousResponseId?: string | null;
  conversationId?: string | null;
  schemaVersion?: string | null;
}

export interface EngineSessionItemsSnapshot {
  backendId: BackendId;
  items: unknown[];
}

export type RunStateSnapshotCallback = (snapshot: EngineRunStateSnapshot) => Promise<void>;
export type SessionItemsSnapshotCallback = (
  snapshot: EngineSessionItemsSnapshot,
) => Promise<void>;

export interface SupportsToolApproval {
  deliverToolApproval(
    approvalId: string,
    decision: ToolApprovalDecision,
    options?: ToolApprovalDeliveryOptions,
  ): Promise<ToolApprovalDeliveryResult> | ToolApprovalDeliveryResult;
}
