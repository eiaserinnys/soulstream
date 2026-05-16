/**
 * Soul Dashboard - 세션 도메인 타입 정의
 *
 * 세션 상태, 프로필, 메타데이터 및 세션 요약/상세 타입.
 * 세션 목록 조회와 세션 카드 렌더링에서 공통으로 사용합니다.
 */

import type { EventRecord } from "./api-types";

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

/** 세션 메타데이터 엔트리.
 *
 * `value`는 본래 string이었으나 caller_info(2026-04-21 도입)처럼
 * 서버가 객체를 영속하는 타입이 추가되어 `string | Record<string, unknown>`로 확장한다.
 * 렌더러는 `typeof entry.value === "object"`로 분기하여 처리해야 한다.
 */
export interface MetadataEntry {
  type: string;
  value: string | Record<string, unknown>;
  label?: string;
  url?: string;
  timestamp?: string;
  tool_name?: string;
}

/** 에이전트 기본 정보 (REST /api/nodes/{nodeId}/agents 응답 항목) */
export interface AgentInfo {
  id: string;
  name: string;
  portraitUrl?: string | null;
  max_turns?: number | null;
}

/** 에이전트 프로필 (SessionSummary에 포함되는 필드) */
export interface AgentProfile {
  agentId?: string | null;
  agentName?: string | null;
  agentPortraitUrl?: string | null;
}

/** 사용자 프로필 (SessionSummary에 포함되는 필드) */
export interface UserProfile {
  userName?: string | null;
  userPortraitUrl?: string | null;
}

/** 세션 요약 정보 (목록 조회용) */
export interface SessionSummary extends AgentProfile, UserProfile {
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
  /** away_summary (세션 복귀 시 요약) */
  awaySummary?: string | null;
  /** 세션을 생성한 노드 ID */
  nodeId?: string;
  /** 세션을 처리하는 백엔드 (claude / codex 등). agent_profiles에서 derived. */
  backend?: string;
  /** 이 세션을 띄운 발신 세션 ID (위임 세션이면 존재, 직접이면 undefined) */
  callerSessionId?: string;
}

/** 세션 상세 정보 */
export interface SessionDetail extends SessionSummary {
  claudeSessionId?: string;
  result?: string;
  error?: string;
  events: EventRecord[];
}
