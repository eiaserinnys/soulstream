/**
 * session-stream-helpers.ts
 *
 * TanStack Query 캐시 업데이트를 위한 순수 함수 모음.
 * SSE 이벤트(session_created/updated/deleted) 수신 시 InfiniteData<SessionPage>를
 * 불변(immutable) 방식으로 변환하는 로직을 컴포넌트 밖으로 분리한다.
 */

import type { InfiniteData } from "@tanstack/react-query";
import type {
  SessionSummary,
  CatalogState,
  MetadataEntry,
} from "../shared/types";
import type { SessionUpdatedStreamEvent } from "../shared/stream-events";
import { normalizeSessionStatus } from "../shared/session-status";
import {
  applyCatalogDisplayName,
  mergeSessionCreatedSummary,
} from "./session-catalog-helpers";
export { normalizeSessionStatus } from "../shared/session-status";
export {
  applyCatalogDisplayNames,
  mergeSessionAssignmentsFromSummaries,
  mergeSessionCreatedSummary,
  preserveCatalogSessionList,
  removeSessionFromCatalogSessionList,
  updateSessionInCatalogSessionList,
  upsertSessionAssignmentInCatalog,
  upsertSessionInCatalogSessionList,
} from "./session-catalog-helpers";

export interface SessionPage {
  sessions: SessionSummary[];
  total: number;
}

/**
 * 피드 세션 필터링 + 정렬 순수 함수.
 * Zustand getFeedSessions와 동일한 로직 — 훅/컴포넌트에서 import하여 사용.
 *
 * - llm 세션 제외
 * - excludeFromFeed 폴더 제외 (미분류 세션은 항상 포함)
 * - updatedAt/createdAt 내림차순 정렬
 */
export function filterFeedSessions(
  sessions: SessionSummary[],
  catalog: CatalogState | null,
): SessionSummary[] {
  return sessions
    .filter((s) => {
      if (s.sessionType === "llm") return false;
      if (catalog) {
        const assignment = catalog.sessions[s.agentSessionId];
        const folderId = assignment?.folderId ?? null;
        if (folderId !== null) {
          const folder = catalog.folders.find((f) => f.id === folderId);
          if (folder?.settings?.excludeFromFeed) return false;
        }
      }
      const t = s.updatedAt ?? s.createdAt;
      return t != null && Number.isFinite(new Date(t).getTime());
    })
    .sort((a, b) => {
      const ta = new Date(a.updatedAt ?? a.createdAt ?? 0).getTime();
      const tb = new Date(b.updatedAt ?? b.createdAt ?? 0).getTime();
      return tb - ta;
    })
    .map((s) => {
      const assignment = catalog?.sessions[s.agentSessionId];
      if (assignment?.displayName) {
        return { ...s, displayName: assignment.displayName };
      }
      return s;
    });
}

/**
 * 폴더 내 세션 필터링 순수 함수.
 * FolderContents에서 TanStack Query 캐시의 전체 세션을 필터링할 때 사용.
 *
 * - llm 세션 제외
 * - folderId가 null이면 미분류(카탈로그 미등록 or folderId=null) 세션만 반환
 * - folderId가 있으면 해당 폴더 세션만 반환
 * - catalog.sessions의 displayName 오버라이드 적용
 */
export function filterSessionsInFolder(
  sessions: SessionSummary[],
  catalog: CatalogState | null,
  folderId: string | null,
): SessionSummary[] {
  if (!catalog?.sessions) return sessions;
  return sessions
    .filter((s) => {
      if (s.sessionType === "llm") return false;
      const assignment = catalog.sessions[s.agentSessionId];
      if (folderId === null) {
        // 미분류: 카탈로그에 없거나 folderId가 null인 세션
        return !assignment || assignment.folderId === null;
      }
      return assignment?.folderId === folderId;
    })
    .map((s) => {
      const assignment = catalog.sessions[s.agentSessionId];
      if (assignment?.displayName) {
        return { ...s, displayName: assignment.displayName };
      }
      return s;
    });
}

function sessionMatchesCatalogCache(
  session: SessionSummary,
  catalog: CatalogState,
  cacheQueryKey: readonly unknown[],
): boolean {
  const typeFilter = (cacheQueryKey[1] as string | undefined) ?? "all";
  const vMode = (cacheQueryKey[2] as string | undefined) ?? "feed";
  const fId = (cacheQueryKey[3] as string | null | undefined) ?? null;
  const sessionIds = cacheQueryKey[4] as readonly string[] | undefined;

  if (typeFilter !== "all" && session.sessionType !== typeFilter) return false;
  if (vMode === "ids") return sessionIds?.includes(session.agentSessionId) === true;

  const assignment = catalog.sessions[session.agentSessionId];
  const assignedFolderId = assignment?.folderId ?? null;

  if (vMode === "folder") {
    if (fId === null) return !assignment || assignment.folderId === null;
    return assignedFolderId === fId;
  }

  if (vMode === "feed") {
    if (session.sessionType === "llm") return false;
    if (assignedFolderId === null) return true;
    const folder = catalog.folders.find((f) => f.id === assignedFolderId);
    return folder?.settings?.excludeFromFeed !== true;
  }

  return true;
}

/**
 * catalog_updated 이벤트 후 기존 세션 목록 캐시를 정본 폴더 배정에 맞춰 즉시 정리한다.
 *
 * invalidateQueries만으로는 기존 데이터가 refetch 완료 전까지 화면에 남는다. 따라서 여기서
 * 각 queryKey(feed/folder/type)에 맞지 않는 세션을 먼저 제거하고, refetch는 누락된 target
 * folder 항목을 채우는 보강 경로로 둔다.
 */
export function reconcileSessionPagesForCatalog(
  data: InfiniteData<SessionPage>,
  cacheQueryKey: readonly unknown[],
  catalog: CatalogState,
): InfiniteData<SessionPage> {
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      sessions: page.sessions
        .filter((session) =>
          sessionMatchesCatalogCache(session, catalog, cacheQueryKey),
        )
        .map((session) => applyCatalogDisplayName(session, catalog)),
    })),
  };
}

export function countLoadedSessionsForQuery(
  pages: SessionPage[],
  cacheQueryKey: readonly unknown[],
  catalog: CatalogState | null,
): number {
  const vMode = (cacheQueryKey[2] as string | undefined) ?? "feed";
  const seen = new Set<string>();
  let count = 0;
  for (const page of pages) {
    for (const session of page.sessions) {
      if (seen.has(session.agentSessionId)) continue;
      seen.add(session.agentSessionId);
      if (
        catalog &&
        vMode === "feed" &&
        !sessionMatchesCatalogCache(session, catalog, cacheQueryKey)
      ) {
        continue;
      }
      count += 1;
    }
  }
  return count;
}

/**
 * session_created 이벤트:
 * filter가 'all'이거나 newSession.sessionType이 filter와 일치할 때
 * pages[0] 앞에 newSession을 prepend한다.
 * filter 불일치 시 data를 그대로 반환한다.
 */
/**
 * F-A(2026-05-17): SSE session_created 이벤트가 N개의 ["sessions", ...] 캐시 중
 * 어느 캐시에 prepend되어야 하는지 결정하는 순수 predicate.
 *
 * queryKey 구조: ["sessions", sessionTypeFilter, viewMode, effectiveFolderId]
 * (useSessionListProvider.ts L70-73 정본).
 *
 * 규칙:
 * - typeFilter !== "all" + newSession.sessionType !== typeFilter → 제외
 * - viewMode === "folder" + cache fId !== event folderId → 제외
 * - viewMode === "feed" + catalog상 folder가 excludeFromFeed=true → 제외
 * - 그 외 → 적용
 *
 * design-principles §5 "제어의 단일 경로": setQueriesData에 inline predicate를 두지 않고
 * 본 helper로 추출하여 단위 테스트 표면 확보.
 */
export function shouldApplySessionCreatedToCache(
  cacheQueryKey: readonly unknown[],
  newSessionType: string | undefined,
  newSessionFolderId: string | null | undefined,
  catalog?: CatalogState | null,
  newSessionId?: string,
): boolean {
  const typeFilter = (cacheQueryKey[1] as string | undefined) ?? "all";
  const vMode = (cacheQueryKey[2] as string | undefined) ?? "feed";
  const fId = (cacheQueryKey[3] as string | null | undefined) ?? null;
  const sessionIds = cacheQueryKey[4] as readonly string[] | undefined;
  if (typeFilter !== "all" && newSessionType !== typeFilter) return false;
  if (vMode === "ids") return newSessionId !== undefined && sessionIds?.includes(newSessionId) === true;
  // viewMode=folder 캐시 — newSessionFolderId가 undefined(assignment 불명)이면
  // fId(string|null) !== undefined → 항상 false → 어떤 folder 캐시에도 prepend 안 함
  if (vMode === "folder" && fId !== newSessionFolderId) return false;
  if (vMode === "feed") {
    if (newSessionType === "llm") return false;
    if (catalog && newSessionFolderId) {
      const folder = catalog.folders.find((f) => f.id === newSessionFolderId);
      if (folder?.settings?.excludeFromFeed) return false;
    }
  }
  return true;
}

/**
 * session_created 이벤트:
 * pages[0] 앞에 newSession을 prepend하고 total을 +1. 낙관적 업데이트(addOptimisticSession)가
 * 임시 세션을 박은 상태면 *정의된 server 필드로 덮어쓴다* — `mergeSessionCreatedSummary` 적용.
 *
 * 직전 동작(`if (exists) return data`)이 server 정본을 silent skip 하던 결함 정정.
 * 임시 세션의 빈 필드(userName·portraitUrl·agentName·agentPortraitUrl·lastEventId 등)가
 * server `session_created` wire 도착 시점에 즉시 채워진다 — 분석 캐시
 * `20260518-1405-cycle-a-optimistic-session-merge.md`.
 *
 * F-A(2026-05-17) 이후: 본 함수는 cache 차원 적합성(typeFilter, viewMode, folderId)을
 * 검사하지 않는다 — 호출자가 setQueriesData predicate(shouldApplySessionCreatedToCache)로
 * 결정한다 (design-principles §3 정본 하나, §5 제어의 단일 경로). 본 fix는 2-arg signature를
 * 유지하여 분리 정본을 보존.
 */
export function applySessionCreated(
  data: InfiniteData<SessionPage>,
  newSession: SessionSummary,
): InfiniteData<SessionPage> {
  const exists = data.pages.some((page) =>
    page.sessions.some((s) => s.agentSessionId === newSession.agentSessionId),
  );
  if (exists) {
    return {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        sessions: page.sessions.map((s) =>
          s.agentSessionId === newSession.agentSessionId
            ? mergeSessionCreatedSummary(s, newSession)
            : s,
        ),
      })),
    };
  }
  return {
    ...data,
    pages: data.pages.map((page, i) =>
      i === 0
        ? {
            ...page,
            sessions: [newSession, ...page.sessions],
            total: page.total + 1,
          }
        : page,
    ),
  };
}

/**
 * session_updated 이벤트:
 * 모든 페이지에서 agentSessionId가 일치하는 세션에 updates를 병합한다.
 * 일치하는 세션이 없으면 data를 그대로 반환한다.
 */
export function applySessionUpdated(
  data: InfiniteData<SessionPage>,
  agentSessionId: string,
  updates: Partial<SessionSummary>,
): InfiniteData<SessionPage> {
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      sessions: page.sessions.map((s) =>
        s.agentSessionId === agentSessionId ? { ...s, ...updates } : s,
      ),
    })),
  };
}

/**
 * TanStack Query 캐시의 모든 SessionPage 데이터를 순회하여
 * agentSessionId와 일치하는 첫 번째 SessionSummary를 찾는다.
 * 없으면 null을 반환한다.
 */
export function findSessionInPages(
  allPages: ReadonlyArray<readonly [unknown, InfiniteData<SessionPage> | undefined]>,
  agentSessionId: string,
): SessionSummary | null {
  for (const [, data] of allPages) {
    if (!data) continue;
    for (const page of data.pages) {
      const found = page.sessions.find(
        (s) => s.agentSessionId === agentSessionId,
      );
      if (found) return found;
    }
  }
  return null;
}

export type SessionUpdatesPatch = Partial<
  Pick<
    SessionSummary,
    | "status"
    | "updatedAt"
    | "lastMessage"
    | "lastEventId"
    | "lastReadEventId"
    | "reviewRequired"
    | "reviewState"
    // F-10C fix(2026-05-08): SSE session_updated wire가 운반하는 user 프로필.
    // catalog API와 정합 — userName/userPortraitUrl이 SessionSummary(UserProfile extend)
    // 멤버이므로 Pick 범위 확장만으로 타입 정합.
    | "userName"
    | "userPortraitUrl"
  >
>;

/**
 * session_updated 이벤트 페이로드에서 SessionSummary에 적용할 업데이트 조각만 추출한다.
 * 이벤트 필드가 null/undefined일 때는 기존 값을 보존하기 위해 해당 키를 건너뛴다.
 */
export function buildSessionUpdates(
  event: SessionUpdatedStreamEvent,
): SessionUpdatesPatch {
  const updates: SessionUpdatesPatch = {};
  if (event.status != null) {
    updates.status = normalizeSessionStatus(event.status);
  }
  if (event.updated_at != null) {
    updates.updatedAt = event.updated_at;
  }
  if (event.last_message) {
    updates.lastMessage = {
      type: event.last_message.type,
      preview: event.last_message.preview,
      timestamp: event.last_message.timestamp,
    };
  }
  if (event.last_event_id != null) {
    updates.lastEventId = event.last_event_id;
  }
  if (event.last_read_event_id != null) {
    updates.lastReadEventId = event.last_read_event_id;
  }
  const reviewRequired = event.review_required ?? event.reviewRequired;
  if (reviewRequired !== undefined) {
    updates.reviewRequired = reviewRequired;
  }
  const reviewState = event.review_state ?? event.reviewState;
  if (
    reviewState === "not_required" ||
    reviewState === "needs_review" ||
    reviewState === "acknowledged"
  ) {
    updates.reviewState = reviewState;
  }
  // F-10C fix(2026-05-08): SSE session_updated wire의 user 프로필을 store에 머지.
  // catalog API가 박는 키와 동일 (userName/userPortraitUrl). null이면 머지 안 함
  // (기존 값 보존 — graceful, partial update 의미 유지).
  if (event.userName !== undefined && event.userName !== null) {
    updates.userName = event.userName;
  }
  if (event.userPortraitUrl !== undefined && event.userPortraitUrl !== null) {
    updates.userPortraitUrl = event.userPortraitUrl;
  }
  return updates;
}

/**
 * metadata_updated 이벤트:
 * 모든 페이지에서 agentSessionId가 일치하는 세션의 metadata를 교체한다.
 */
export function applyMetadataUpdated(
  data: InfiniteData<SessionPage>,
  agentSessionId: string,
  metadata: MetadataEntry[],
): InfiniteData<SessionPage> {
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      sessions: page.sessions.map((s) =>
        s.agentSessionId === agentSessionId ? { ...s, metadata } : s,
      ),
    })),
  };
}

/**
 * session_deleted 이벤트:
 * 모든 페이지에서 agentSessionId가 일치하는 세션을 제거한다.
 * 일치하는 세션이 없으면 data를 그대로 반환한다.
 */
export function applySessionDeleted(
  data: InfiniteData<SessionPage>,
  agentSessionId: string,
): InfiniteData<SessionPage> {
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      sessions: page.sessions.filter(
        (s) => s.agentSessionId !== agentSessionId,
      ),
    })),
  };
}
