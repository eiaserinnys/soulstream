/**
 * Soul Dashboard - 세션 스트림 SSE 이벤트 타입 정의
 *
 * /sessions/stream 엔드포인트에서 클라이언트에 푸시되는 이벤트들.
 * 세션 목록 갱신, 카탈로그 변경, 메타데이터 업데이트의 실시간 전파에 사용.
 */

import type { CatalogState } from "./catalog-types";
import type {
  LastMessage,
  MetadataEntry,
  SessionStatus,
  SessionSummary,
} from "./session-types";

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
