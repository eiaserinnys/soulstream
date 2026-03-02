/**
 * Soul Dashboard - Session Storage Provider Types
 *
 * 세션 데이터의 소스를 추상화하는 Provider 인터페이스 정의.
 * File 모드(기존 JSONL + SSE)와 Serendipity 모드를 통합합니다.
 */

import type { SessionSummary, DashboardCard, SoulSSEEvent } from "@shared/types";

// === Storage Mode ===

/** 대시보드 스토리지 모드 */
export type StorageMode = "file" | "serendipity";

// === Provider 인터페이스 ===

/**
 * 세션 목록을 제공하는 Provider 인터페이스.
 *
 * 각 모드별 구현체가 이 인터페이스를 구현합니다.
 */
export interface SessionListProvider {
  /** 세션 목록 조회 */
  fetchSessions(): Promise<SessionSummary[]>;

  /** Provider 타입 식별자 */
  readonly mode: StorageMode;
}

/**
 * 세션 상세 정보를 제공하는 Provider 인터페이스.
 *
 * File 모드: SSE 스트림을 구독하여 실시간 업데이트
 * Serendipity 모드: API로 블록 조회 후 DashboardCard로 변환
 */
export interface SessionDetailProvider {
  /** 세션 카드 목록 조회 (스냅샷) */
  fetchCards(sessionKey: string): Promise<DashboardCard[]>;

  /**
   * 실시간 업데이트 구독.
   *
   * @param sessionKey - 세션 식별자
   * @param onEvent - 이벤트 수신 콜백
   * @returns 구독 해제 함수
   */
  subscribe(
    sessionKey: string,
    onEvent: (event: SoulSSEEvent, eventId: number) => void
  ): () => void;

  /** Provider 타입 식별자 */
  readonly mode: StorageMode;
}

/**
 * 통합 Provider 인터페이스.
 *
 * SessionListProvider와 SessionDetailProvider를 결합합니다.
 */
export interface SessionStorageProvider
  extends SessionListProvider,
    SessionDetailProvider {}

// === Serendipity 블록 타입 ===

/**
 * Serendipity 블록 타입 (Soul Plugin 전용).
 *
 * Soul에서 세렌디피티로 저장할 때 사용되는 블록 타입입니다.
 */
export type SoulBlockType =
  | "soul:user"
  | "soul:assistant"
  | "soul:thinking"
  | "soul:tool_use"
  | "soul:tool_result"
  | "soul:error"
  | "paragraph"; // 기본 텍스트 블록

/**
 * Serendipity 블록 인터페이스.
 *
 * 세렌디피티 API에서 반환하는 블록 구조입니다.
 */
export interface SerendipityBlock {
  id: string;
  pageId: string;
  parentId: string | null;
  order: number;
  type: SoulBlockType | string;
  content: PortableTextContent;
  collapsed?: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Portable Text 콘텐츠 형식.
 *
 * Serendipity의 블록 콘텐츠는 Portable Text 형식을 사용합니다.
 */
export interface PortableTextContent {
  _version: number;
  content: PortableTextBlock[];
}

export interface PortableTextBlock {
  _key: string;
  _type: "block";
  style: "normal" | "h1" | "h2" | "h3" | "blockquote";
  children: PortableTextSpan[];
  markDefs: PortableTextMarkDef[];
  listItem?: "bullet" | "number";
  level?: number;
}

export interface PortableTextSpan {
  _key: string;
  _type: "span";
  text: string;
  marks: string[];
}

export interface PortableTextMarkDef {
  _key: string;
  _type: string;
  [key: string]: unknown;
}

// === Session Key 유틸리티 ===

/**
 * Serendipity 페이지 ID를 세션 키로 사용.
 *
 * File 모드: "clientId:requestId" 형식
 * Serendipity 모드: 페이지 UUID
 */
export type SessionKey = string;
