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
export { normalizeSessionStatus } from "../shared/session-status";

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
 * - 24시간 이내 활동한 세션만 포함
 * - updatedAt/createdAt 내림차순 정렬
 */
export function filterFeedSessions(
  sessions: SessionSummary[],
  catalog: CatalogState | null,
): SessionSummary[] {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
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
      const t = s.lastMessage?.timestamp ?? s.updatedAt ?? s.createdAt;
      return t != null && new Date(t).getTime() > cutoff;
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

/**
 * 카탈로그의 displayName override만 적용한다.
 *
 * useSessionListProvider가 이미 folder_id로 서버 필터링한 목록을 FolderContents에
 * 넘기는 경로에서는 catalog.sessions 할당이 늦게 도착할 수 있다. 그 목록에 다시
 * 폴더 필터를 걸면 방금 생성된 세션이 폴더 뷰에서 사라질 수 있으므로, prop 기반
 * 경로에서는 provider 결과를 신뢰하고 표시명만 덧씌운다.
 */
export function applyCatalogDisplayNames(
  sessions: SessionSummary[],
  catalog: CatalogState | null,
): SessionSummary[] {
  if (!catalog?.sessions) return sessions;
  return sessions.map((s) => {
    const assignment = catalog.sessions[s.agentSessionId];
    if (assignment?.displayName) {
      return { ...s, displayName: assignment.displayName };
    }
    return s;
  });
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
 * - 그 외 → 적용
 *
 * design-principles §5 "제어의 단일 경로": setQueriesData에 inline predicate를 두지 않고
 * 본 helper로 추출하여 단위 테스트 표면 확보.
 */
export function shouldApplySessionCreatedToCache(
  cacheQueryKey: readonly unknown[],
  newSessionType: string | undefined,
  newSessionFolderId: string | undefined,
): boolean {
  const typeFilter = cacheQueryKey[1] as string;
  const vMode = cacheQueryKey[2] as string;
  const fId = cacheQueryKey[3] as string | null;
  if (typeFilter !== "all" && newSessionType !== typeFilter) return false;
  // viewMode=folder 캐시 — newSessionFolderId가 undefined(assignment 불명)이면
  // fId(string|null) !== undefined → 항상 false → 어떤 folder 캐시에도 prepend 안 함
  if (vMode === "folder" && fId !== newSessionFolderId) return false;
  return true;
}

/**
 * 낙관적 세션이 캐시에 박힌 상태에서 서버 정본 `session_created`가 도착할 때, *정의된 incoming
 * 필드만* 덮어쓰는 helper. 분석 캐시 `20260518-1405-cycle-a-optimistic-session-merge.md`.
 *
 * - `undefined`만 filter — 서버가 *명시적으로 박지 않은 필드*는 기존 값 보존
 * - `null`은 *유효 unset*이므로 살림 (session-types: `agentPortraitUrl?: string | null` 등)
 * - 순수 함수 — InfiniteData·캐시 상태 불변
 *
 * 필드별 null 안전성 (spec-reviewer P2-3):
 * - portrait 계열(`agentPortraitUrl`·`userPortraitUrl`·`awaySummary`): 타입 `string | null` —
 *   서버가 null로 명시적 unset 가능. 본 helper가 살림 동작 정합.
 * - `lastEventId`: 타입 `number | undefined` — null 도달 불가. wire가 null을 보내도 type-safe
 *   하지 않은 entry. 본 helper의 일관성 정합 (`null`을 살리는 일반 규칙으로 처리).
 */
export function mergeSessionCreatedSummary(
  current: SessionSummary,
  incoming: SessionSummary,
): SessionSummary {
  const definedIncoming = Object.fromEntries(
    Object.entries(incoming).filter(([, value]) => value !== undefined),
  ) as Partial<SessionSummary>;
  return { ...current, ...definedIncoming };
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

/**
 * catalog.sessions에 { agentSessionId → { folderId, displayName: null } } 매핑을
 * 낙관적으로 추가한 새 CatalogState를 반환한다.
 * (session_created에서 서버가 folder_id를 함께 보내는 경우 사용)
 */
export function upsertSessionAssignmentInCatalog(
  catalog: CatalogState,
  agentSessionId: string,
  folderId: string,
): CatalogState {
  return {
    ...catalog,
    sessions: {
      ...catalog.sessions,
      [agentSessionId]: { folderId, displayName: null },
    },
  };
}

export type SessionUpdatesPatch = Partial<
  Pick<
    SessionSummary,
    | "status"
    | "updatedAt"
    | "lastMessage"
    | "lastEventId"
    | "lastReadEventId"
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
