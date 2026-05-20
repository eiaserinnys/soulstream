/**
 * Soul Dashboard - REST API 요청/응답 타입 정의
 *
 * 대시보드와 Soul 서버 간 REST 인터페이스 타입.
 * EventStore JSONL 레코드 형식도 함께 정의합니다.
 */

import type { SessionSummary } from "./session-types";

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "xhigh";

export const REASONING_EFFORT_OPTIONS: readonly {
  value: ReasoningEffort;
  label: string;
}[] = [
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "X High" },
];

// === JSONL Record ===

/** EventStore JSONL 레코드 형식 (파일의 한 줄) */
export interface EventRecord {
  id: number;
  event: Record<string, unknown>;
}

// === API Request/Response ===

/** POST /api/sessions 요청 (대시보드에서 세션 생성 또는 resume) */
export interface CreateSessionRequest {
  prompt: string;
  /** resume 시 기존 세션 ID. 없으면 새 세션 생성 (Soul 서버가 ID 생성). */
  agentSessionId?: string;
  /** 세션을 배치할 폴더 ID. 미지정 시 session_type 기반 자동 배정. */
  folderId?: string;
  /** 에이전트 프로필 ID. 지정 시 해당 에이전트로 세션 실행. */
  profile?: string;
  /** 추론 backend(codex/claude)용 reasoning effort. 생략 시 서버 기본값 xhigh. */
  reasoningEffort?: ReasoningEffort;
}

/** POST /api/sessions 응답 */
export interface CreateSessionResponse {
  agentSessionId: string;
  status: "running";
  nodeId?: string;
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
