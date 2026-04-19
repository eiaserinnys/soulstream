/**
 * Soul Dashboard - Session Storage Provider Types
 *
 * 세션 데이터의 소스를 추상화하는 Provider 인터페이스 정의.
 * Soul Server API + SSE 스트림을 통한 실시간 업데이트.
 */

import type { SessionSummary, EventTreeNode, SoulSSEEvent } from "@shared/types";

// === Provider 인터페이스 ===

/** 세션 목록 조회 옵션 */
export interface FetchSessionsOptions {
  /** 세션 타입 필터 */
  sessionType?: string;
  /** 페이지네이션 오프셋 (0-based) */
  offset?: number;
  /** 페이지 크기 */
  limit?: number;
  /** 폴더 ID 필터 (UUID). 없으면 전체 조회. */
  folderId?: string;
  /** true이면 excludeFromFeed=true인 폴더의 세션을 서버에서 제외. */
  feedOnly?: boolean;
}

/**
 * 세션 목록을 제공하는 Provider 인터페이스.
 */
/** 세션 목록 조회 결과 */
export interface SessionListResult {
  sessions: SessionSummary[];
  total: number;
  /** 추가 로드 가능 여부 (loaded < total) */
  hasMore?: boolean;
}

export interface SessionListProvider {
  /** 세션 목록 조회 (페이지네이션 + 타입 필터 지원) */
  fetchSessions(options?: FetchSessionsOptions): Promise<SessionListResult>;

  /** 폴더별 세션 수 조회. 구현 선택 사항 — 없으면 sessions 배열로 클라이언트 집계. */
  fetchFolderCounts?(): Promise<Record<string, number>>;
}

/**
 * 세션 상세 정보를 제공하는 Provider 인터페이스.
 *
 * SSE 스트림을 구독하여 실시간 업데이트를 수신합니다.
 */
export interface SessionDetailProvider {
  /** 세션 카드 목록 조회 (스냅샷) */
  fetchCards(sessionKey: string): Promise<EventTreeNode[]>;

  /**
   * 실시간 업데이트 구독.
   *
   * @param sessionKey - 세션 식별자
   * @param onEvent - 이벤트 수신 콜백
   * @param onStatusChange - 연결 상태 변경 콜백 (SSE 재연결 시 UI 반영용)
   * @returns 구독 해제 함수
   */
  subscribe(
    sessionKey: string,
    onEvent: (event: SoulSSEEvent, eventId: number) => void,
    onStatusChange?: (status: "connecting" | "connected" | "error") => void,
    options?: { lastEventId?: number; mode?: "full" | "live" },
  ): () => void;
}

/**
 * 통합 Provider 인터페이스.
 *
 * SessionListProvider와 SessionDetailProvider를 결합합니다.
 */
export interface SessionStorageProvider
  extends SessionListProvider,
    SessionDetailProvider {}

// === Session Key 유틸리티 ===

/**
 * 세션 키 (agentSessionId).
 */
export type SessionKey = string;
