import type { Catalog } from './types';

export type {
  HistoricalMessage,
  MessagesResponse,
  ToolTraceResponse,
} from './historyTypes';

// getCatalog는 /api/folders + /api/sessions를 조립해 Catalog(folders + sessions 폴더 배정 맵) 외에
// sessionList(camelCase, Phase A-bis 2026-05-16)과 total을 함께 반환한다.
//
// sessionList의 각 item은 orch `_session_to_response()` 정본 helper의 결과(camelCase 21 키).
// 본 클라이언트는 raw 형태(unknown record)로 받아 호출자(useSessionsStream/useFolderPagination)가
// `api/mappers.ts:toSession`으로 정규화한 뒤 Session 타입으로 사용한다 — wire→타입 변환의
// 정본을 한 곳(mappers.ts)에 둔다 (design-principles §3).
export interface CatalogResponse extends Catalog {
  sessionList?: Array<Record<string, unknown>>;
  total?: number;
}
