import type { Session, Catalog } from '../api/types';
import { getSessionFeedActivityMs } from './session-feed-activity';

interface FeedFilterOptions {
  catalogReady?: boolean;
}

/**
 * 피드용 세션 필터.
 *
 * - LLM 세션(sessionType === 'llm') 제외 — 어시스턴트 채팅이 아닌 LLM 호출 세션은 피드에 노이즈.
 * - `excludeFromFeed`가 켜진 폴더에 속한 세션은 제외.
 * - 미분류 세션(folderId가 null/undefined) 또는 카탈로그에 등록되지 않은 세션은 항상 포함.
 *
 * 정렬: 최신 유효 lastMessage.timestamp DESC. 메시지가 없는 legacy snapshot은
 * createdAt, 마지막으로 updatedAt을 fallback한다. 동률이면 agentSessionId DESC.
 *
 * catalogReady=false는 앱 시작·서버 전환 중 raw 세션이 먼저 들어온 상태다.
 * 이때는 excludeFromFeed 폴더 정보를 아직 신뢰할 수 없으므로 피드 표시 결과를 비운다.
 *
 * 정본 매핑은 catalog.sessions[sid].folderId. session.folderId는 fallback (catalog 비동기 도착 전).
 *
 * 비교 대상: soul-ui `hooks/session-stream-helpers.ts` `filterFeedSessions` —
 *   같은 의미를 평면 RN 환경에 맞게 단순화.
 *
 * Phase A-bis(2026-05-16): Session 타입 camelCase 통일에 따라 키 변경
 * (session_id → agentSessionId, session_type → sessionType, folder_id → folderId,
 *  updated_at → updatedAt).
 */
export function filterFeedSessions(
  sessions: Session[] | Record<string, Session>,
  catalog: Catalog,
  options: FeedFilterOptions = {},
): Session[] {
  if (options.catalogReady === false) return [];

  const list = Array.isArray(sessions) ? sessions : Object.values(sessions);

  // excludeFromFeed가 켜진 폴더 id 집합.
  const excludedFolderIds = new Set(
    catalog.folders
      .filter((f) => f.settings?.excludeFromFeed)
      .map((f) => f.id),
  );

  // 폴더 매핑 정본은 catalog.sessions[sid].folderId. 없으면 session.folderId fallback.
  function folderIdOf(s: Session): string | null | undefined {
    const fromCatalog = catalog.sessions[s.agentSessionId]?.folderId;
    if (fromCatalog !== undefined) return fromCatalog;
    return s.folderId ?? null;
  }

  return list
    .flatMap((session) => {
      // LLM 세션은 항상 제외 (web 정본 패턴, session-stream-helpers.ts).
      if (session.sessionType === 'llm') return [];
      // 정렬 기준이 없으면 위치가 불안정하므로 제외한다.
      const activityMs = getSessionFeedActivityMs(session);
      if (activityMs === null) return [];
      // 폴더 제외 (미분류는 통과).
      const fid = folderIdOf(session);
      if (fid && excludedFolderIds.has(fid)) return [];
      // lastMessage validation은 최대 200 codepoint를 훑으므로 comparator에서 반복하지 않는다.
      return [{ session, activityMs }];
    })
    .sort(
      (a, b) => {
        const timestampOrder = b.activityMs - a.activityMs;
        if (timestampOrder !== 0) return timestampOrder;
        if (a.session.agentSessionId === b.session.agentSessionId) return 0;
        return a.session.agentSessionId > b.session.agentSessionId ? -1 : 1;
      },
    )
    .map(({ session }) => session);
}
