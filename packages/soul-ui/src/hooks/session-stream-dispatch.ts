/**
 * useSessionStreamSSE 내부에서 사용되는 순수 dispatch 헬퍼.
 *
 * 인터페이스가 테스트 표면 — hook을 우회하지 않고도 dispatch 라우팅과
 * SSE id 주입을 검증할 수 있도록 분리한다.
 */

import type {
  CatalogUpdatedStreamEvent,
  CustomViewUpdatedStreamEvent,
  MetadataUpdatedStreamEvent,
  PageUpdatedStreamEvent,
  ReplayGapStreamEvent,
  TaskUpdatedStreamEvent,
  SessionCreatedStreamEvent,
  SessionDeletedStreamEvent,
  SessionListStreamEvent,
  SessionStreamEvent,
  SessionUpdatedStreamEvent,
  StreamMetaStreamEvent,
} from "../shared/stream-events";

export interface SessionStreamHandlers {
  /** 타입별 처리가 끝난 뒤 모든 stream event를 한 경계에서 관찰한다. */
  onEvent?: (event: SessionStreamEvent) => void;
  onSessionList?: (event: SessionListStreamEvent) => void;
  onSessionCreated?: (event: SessionCreatedStreamEvent) => void;
  onSessionUpdated?: (event: SessionUpdatedStreamEvent) => void;
  onSessionDeleted?: (event: SessionDeletedStreamEvent) => void;
  onCatalogUpdated?: (event: CatalogUpdatedStreamEvent) => void;
  onMetadataUpdated?: (event: MetadataUpdatedStreamEvent) => void;
  onTaskUpdated?: (event: TaskUpdatedStreamEvent) => void;
  onCustomViewUpdated?: (event: CustomViewUpdatedStreamEvent) => void;
  onPageUpdated?: (event: PageUpdatedStreamEvent) => void;
  onStreamMeta?: (event: StreamMetaStreamEvent) => void;
  onReplayGap?: (event: ReplayGapStreamEvent) => void;
}

/**
 * 타입에 따라 적절한 핸들러로 라우팅한다. 매치되지 않는 타입은 silent skip.
 */
export function dispatchSessionStreamEvent(
  event: SessionStreamEvent,
  handlers: SessionStreamHandlers,
): void {
  switch (event.type) {
    case "session_list":
      handlers.onSessionList?.(event);
      break;
    case "session_created":
      handlers.onSessionCreated?.(event);
      break;
    case "session_updated":
      handlers.onSessionUpdated?.(event);
      break;
    case "session_deleted":
      handlers.onSessionDeleted?.(event);
      break;
    case "catalog_updated":
      handlers.onCatalogUpdated?.(event);
      break;
    case "metadata_updated":
      handlers.onMetadataUpdated?.(event);
      break;
    case "task_updated":
      handlers.onTaskUpdated?.(event);
      break;
    case "runbook_updated": {
      const normalized: TaskUpdatedStreamEvent = {
        type: "task_updated",
        taskId: event.runbookId,
        boardItemId: event.boardItemId,
        lastEventId: event.lastEventId,
      };
      handlers.onTaskUpdated?.(normalized);
      handlers.onEvent?.(normalized);
      return;
    }
    case "custom_view_updated":
      handlers.onCustomViewUpdated?.(event);
      break;
    case "page_updated":
      handlers.onPageUpdated?.(event);
      break;
    case "stream_meta":
      handlers.onStreamMeta?.(event);
      break;
    case "replay_gap":
      handlers.onReplayGap?.(event);
      break;
  }
  handlers.onEvent?.(event);
}

/**
 * EventSource MessageEvent를 SessionStreamEvent로 파싱하고 SSE id를 주입한다.
 *
 * - `lastEventId` 빈 문자열은 undefined로 정규화 → 호출자에서 hasOwnProperty 분기 불필요.
 * - JSON 파싱 실패 시 null 반환 (호출자가 silent skip).
 * - stream_meta/session_list/replay_gap는 서버가 SSE id를 부착하지 않아 자연 undefined.
 */
export function parseStreamMessage(
  rawData: string,
  rawLastEventId: string,
): SessionStreamEvent | null {
  try {
    const data = JSON.parse(rawData) as SessionStreamEvent;
    return {
      ...data,
      lastEventId: rawLastEventId || undefined,
    } as SessionStreamEvent;
  } catch {
    return null;
  }
}
