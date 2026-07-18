/**
 * Soul Dashboard - REST API 요청/응답 타입 정의
 *
 * 대시보드와 Soul 서버 간 REST 인터페이스 타입.
 * EventStore JSONL 레코드 형식도 함께 정의합니다.
 */

import type { SessionBindingWarning } from "@soulstream/page-model";

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
  /** 기존 클라이언트가 직접 조립해 보내는 첫 사용자 메시지. initial_instruction과 둘 중 하나는 필수다. */
  prompt?: string;
  /** 서버가 정본 문구와 조립할 새 세션 초기 지시. prompt와 함께 있으면 이 필드가 우선한다. */
  initial_instruction?: string;
  /** resume 시 기존 세션 ID. 없으면 새 세션 생성 (Soul 서버가 ID 생성). */
  agentSessionId?: string;
  /** orchestrator 모드에서 세션을 생성할 대상 노드 ID. */
  nodeId?: string;
  /** 세션을 배치할 폴더 ID. 미지정 시 session_type 기반 자동 배정. */
  folderId?: string | null;
  /** 세션 board item을 배치할 컨테이너. 생략 시 folderId 폴더 보드. */
  container?: { kind: "folder" | "task"; id: string };
  /** 이어하기에서 원 세션의 primary board item 컨테이너를 서버가 상속할 때 사용. */
  sourceSessionId?: string;
  sourceTaskItemId?: string | null;
  /** 에이전트 프로필 ID. 지정 시 해당 에이전트로 세션 실행. */
  profile?: string;
  /** soul-app 호환 별칭. 서버 경계에서 profile로 정규화된다. */
  agentId?: string;
  /** 세션 생성 전에 업로드한 첨부 파일 경로. */
  attachmentPaths?: string[];
  /** 추론 backend(codex/claude)용 reasoning effort. 생략 시 서버 기본값 xhigh. */
  reasoningEffort?: ReasoningEffort;
  /** orchestrator 모드 Claude OAuth 프로필 선택값. */
  oauth_profile_name?: string;
  /** Existing page block converted by the worker into the canonical primary session_ref. */
  pageAnchor?: { pageId: string; blockId: string; expectedVersion: number };
  /** 첫 turn에만 주입할 구조화 context item. 서버 command wire 정본 이름을 유지한다. */
  extra_context_items?: Array<{ key: string; label?: string; content: unknown }>;
}

export type SessionCreationWarning = SessionBindingWarning;

/** POST /api/sessions 응답 */
export interface CreateSessionResponse {
  agentSessionId: string;
  status: "running";
  nodeId?: string;
  /** 서버가 최종 조립하여 worker에 전달한 첫 사용자 메시지. */
  prompt?: string;
  warnings?: SessionCreationWarning[];
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
