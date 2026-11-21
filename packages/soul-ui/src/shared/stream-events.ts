/**
 * Soul Dashboard - 세션 스트림 SSE 이벤트 타입 정의
 *
 * /sessions/stream 엔드포인트에서 클라이언트에 푸시되는 이벤트들.
 * 세션 목록 갱신, 카탈로그 변경, 메타데이터 업데이트의 실시간 전파에 사용.
 */

import type {
  CatalogBoardItemsDelta,
  CatalogFolder,
  CatalogState,
} from "./catalog-types";
import type { CatalogSessionsDelta } from "@soulstream/wire-schema/catalog";
import type { SessionStatus } from "@soulstream/wire-schema";
import type { PersistentReportEntry } from "@soulstream/wire-schema/persistent-report";
import type {
  LastMessage,
  SessionSummary,
} from "./session-types";
import type { ReviewState } from "@soulstream/wire-schema/session-review";
import type { SessionFeedDelta } from "@soulstream/wire-schema/session-feed-contract";

export interface SessionListStreamEvent {
  type: "session_list";
  sessions: SessionSummary[];
  total: number;
}

/** 새 세션 생성 */
export interface SessionCreatedStreamEvent {
  type: "session_created";
  session: SessionSummary;
  /** broadcaster가 부여한 SSE event_id (replay 시 Last-Event-ID 추적용) */
  lastEventId?: string;
}

/** 세션 상태 업데이트 */
export interface SessionUpdatedStreamEvent extends SessionFeedDelta {
  persistent_report?: PersistentReportEntry[];
  type: "session_updated";
  card_id?: string | null;
  agent_session_id: string;
  status?: SessionStatus;
  updated_at?: string;
  last_message?: LastMessage;
  last_event_id?: number;
  last_read_event_id?: number;
  review_required?: boolean;
  review_state?: ReviewState;
  reviewRequired?: boolean;
  reviewState?: ReviewState;
  /**
   * F-10C fix(2026-05-08): SSE session_updated wire가 운반하는 user 프로필.
   * catalog API의 userName/userPortraitUrl과 정합 — buildSessionUpdates가
   * 추출하여 store에 머지. null이면 머지 안 함 (기존 값 보존).
   */
  userName?: string | null;
  userPortraitUrl?: string | null;
  /** broadcaster가 부여한 SSE event_id */
  lastEventId?: string;
}

/** 세션 삭제 */
export interface SessionDeletedStreamEvent {
  type: "session_deleted";
  agent_session_id: string;
  /** broadcaster가 부여한 SSE event_id */
  lastEventId?: string;
}

/** 카탈로그 업데이트 이벤트 — expand 단계 동안 구형 snapshot과 신형 delta를 함께 소비한다. */
export type CatalogUpdatedStreamEvent =
  | {
      type: "catalog_updated";
      catalog: CatalogState;
      folders?: never;
      sessions_delta?: never;
      board_items_delta?: never;
      /** broadcaster가 부여한 SSE event_id */
      lastEventId?: string;
    }
  | {
      type: "catalog_updated";
      catalog?: never;
      folders: CatalogFolder[];
      sessions_delta: CatalogSessionsDelta;
      board_items_delta: CatalogBoardItemsDelta;
      /** broadcaster가 부여한 SSE event_id */
      lastEventId?: string;
    };

export interface FolderUpdatedStreamEvent {
  type: "folder_updated";
  folderId: string;
  /** broadcaster가 부여한 SSE event_id */
  lastEventId?: string;
}

/** 커스텀 뷰 상태 변경 이벤트 — 클라이언트는 서버 snapshot을 다시 읽는다. */
export interface CustomViewUpdatedStreamEvent {
  type: "custom_view_updated";
  customViewId: string;
  boardItemId: string;
  revision: number;
  /** broadcaster가 부여한 SSE event_id */
  lastEventId?: string;
}

/** 페이지 커밋 무효화 이벤트 — 본문과 Yjs update는 다시 읽는다. */
export interface PageUpdatedStreamEvent {
  type: "page_updated";
  page_id: string;
  version: number;
  /** broadcaster가 부여한 SSE event_id */
  lastEventId?: string;
}

/**
 * 스트림 메타 이벤트 (구독 시 최초 1회, SSE id 미부착)
 *
 * orch 인스턴스 식별자(`instance_id`)와 현재 ring buffer의 최신 event_id(`latest_id`)를
 * 클라이언트에 알린다. 클라이언트는 instance_id 변경 시 풀 refetch 후
 * lastEventId를 latest_id로 동기화한다.
 */
export interface StreamMetaStreamEvent {
  type: "stream_meta";
  instance_id: string;
  latest_id: number;
}

/**
 * Replay gap 신호 (SSE id 미부착)
 *
 * 클라이언트가 보낸 Last-Event-ID가 ring buffer 보관 범위를 벗어나
 * 서버가 결손분을 재전송할 수 없을 때 emit. 클라이언트는 풀 refetch 후
 * lastEventId를 latest_id로 끌어올려 다음 사이클부터 정상 resume 한다.
 */
export interface ReplayGapStreamEvent {
  type: "replay_gap";
  latest_id: number;
  instance_id: string;
}

/** 세션 스트림 이벤트 유니온 */
export interface CardUpdatedStreamEvent { type: "card_updated"; cardId: string; folderId: string; lastEventId?: string }

/** 사람이 보낸 글이 전달 장부에서 실패로 닫힘 — 그 세션의 실패 목록을 다시 읽는다. */
export interface SessionDeliveryFailedStreamEvent {
  type: "session_delivery_failed";
  agent_session_id: string;
  /** broadcaster가 부여한 SSE event_id */
  lastEventId?: string;
}

export type SessionStreamEvent =
  | OrchestratorShutdownStreamEvent
  | SessionListStreamEvent
  | SessionCreatedStreamEvent
  | SessionUpdatedStreamEvent
  | SessionDeletedStreamEvent
  | CatalogUpdatedStreamEvent
  | CardUpdatedStreamEvent
  | SessionDeliveryFailedStreamEvent
  | FolderUpdatedStreamEvent
  | CustomViewUpdatedStreamEvent
  | PageUpdatedStreamEvent
  | StreamMetaStreamEvent
  | ReplayGapStreamEvent;

export interface OrchestratorShutdownStreamEvent {
  type:"orchestrator_shutdown";build_id:string;instance_id:string;draining:true;healthy:false;ready:false;lastEventId?:string;
}
