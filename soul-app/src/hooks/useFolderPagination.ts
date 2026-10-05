import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createApiClient } from '../api/client';
import { toSession } from '../api/mappers';
import type { Session } from '../api/types';
import { useSessionStore } from '../store/sessionStore';
import { useSettingsStore } from '../store/settingsStore';
import { captureAuthScope, useAuthScopeGeneration } from '../lib/auth-scope';

/**
 * 폴더 화면 페이지네이션 — 표시 정본을 화면 지역 상태로 보유한다.
 *
 * 피드 스냅샷은 받은 쪽의 행만 feedMembership 후보로 등록한다. 이 훅은 화면 표시용
 * 페이지를 자체 보유하고, 행 cache merge는 피드 후보를 늘리지 않는다.
 *
 * 본 훅의 정본 분리 (design-principles §3·§9):
 * - 폴더 표시의 정본은 훅 내부 items: Session[]. 글로벌 store 변동에 영향받지 않는다.
 * - mergeSessions(list)는 다른 화면이 같은 세션을 열었을 때 쓸 수 있는 세션 cache를
 *   보강한다. 이 cache 보강은 feedMembership 후보를 만들지 않는다.
 *
 * folderId === null 이면 비활성 — items 빈 배열, getCatalog 호출 안 함, loadMore noop.
 *
 * Phase A-bis(2026-05-16): catalog sessionList가 camelCase로 통일됨에 따라
 * 응답 item을 mapper(toSession)로 정규화한 뒤 Session 타입으로 적재한다.
 */

const PAGE_SIZE = 50;

export interface UseFolderPaginationResult {
  items: Session[];
  loading: boolean;
  hasMore: boolean;
  loadMore: () => Promise<void>;
}

export function mergeFolderSessionItems(
  current: Session[],
  incoming: Session[],
): Session[] {
  const map = new Map<string, Session>();
  for (const s of current) {
    if (s.agentSessionId) map.set(s.agentSessionId, s);
  }
  for (const s of incoming) {
    if (!s.agentSessionId) continue;
    const existing = map.get(s.agentSessionId);
    map.set(s.agentSessionId, existing ? { ...existing, ...s } : s);
  }
  const merged = Array.from(map.values());
  merged.sort(
    (a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
  return merged;
}

export function useFolderPagination(folderId: string | null): UseFolderPaginationResult {
  const serverUrl = useSettingsStore((s) => s.serverUrl);
  const scopeGeneration = useAuthScopeGeneration();
  const authScope = useMemo(() => captureAuthScope(), [scopeGeneration]);
  const mergeSessions = useSessionStore((s) => s.mergeSessions);

  const api = useMemo(
    () => (serverUrl ? createApiClient(serverUrl, { authScope }) : null),
    [authScope, serverUrl]
  );

  const [items, setItems] = useState<Session[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  // 동시 fetch 가드 — onEndReached가 빠르게 두 번 발화하거나 첫 페이지 자동 fetch와
  // 사용자 스크롤이 겹치는 경우를 막는다.
  const loadingRef = useRef(false);

  const loadMore = useCallback(async () => {
    if (!api || !folderId) return;
    if (loadingRef.current || !hasMore) return;
    loadingRef.current = true;
    setLoading(true);
    const requestGeneration = scopeGeneration;
    try {
      const cat = await api.getCatalog({
        folder_id: folderId,
        limit: PAGE_SIZE,
        offset,
      });
      if (captureAuthScope().generation !== requestGeneration) return;
      // sessionList raw → camelCase Session (Phase A-bis 정본).
      const list: Session[] = (cat.sessionList ?? []).map((raw) =>
        toSession(raw as unknown as Record<string, unknown>),
      );
      // id 기준 dedup + updatedAt DESC 재정렬. 누적 결과가 항상 정렬 상태를 유지하므로
      // 화면이 추가 정렬할 필요 없다.
      setItems((prev) => mergeFolderSessionItems(prev, list));
      setOffset((prev) => prev + list.length);
      if (list.length < PAGE_SIZE) setHasMore(false);
      // 폴더 목록 페이지를 세션 cache에 보강한다. mergeSessions는 feedMembership을
      // 바꾸지 않으므로 폴더 행이 피드 후보로 불어나지 않는다.
      mergeSessions(list);
    } catch (err) {
      if (captureAuthScope().generation !== requestGeneration) return;
      console.warn('[useFolderPagination] page fetch failed:', err);
    } finally {
      if (captureAuthScope().generation === requestGeneration) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, [api, folderId, hasMore, offset, mergeSessions, scopeGeneration]);

  // folderId 변경 시 전체 reset — null 진입도 정상 reset.
  useEffect(() => {
    setItems([]);
    setOffset(0);
    setHasMore(true);
    setLoading(false);
    loadingRef.current = false;
  }, [folderId, scopeGeneration]);

  // 첫 페이지 자동 fetch — folderId가 set되어 있고 offset=0이며 hasMore면 한 번 호출.
  // (useEffect 안에서 loadMore를 직접 부르면 stale offset을 본다 — state 동기화를
  // 한 사이클 미루기 위해 offset을 의존성에 두고 별도 effect로 분리.)
  useEffect(() => {
    if (folderId && offset === 0 && hasMore) {
      loadMore();
    }
    // loadMore가 의존성에 들어가면 매 렌더마다 재호출되므로 의도적으로 빼둔다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderId, offset, hasMore, scopeGeneration]);

  // 폴더 표시 정본은 지역 items지만, session_created/session_updated/optimistic
  // upsert가 들어오면 같은 folderId의 카드 status/profile은 즉시 보강한다.
  // React hook selector로 전체 sessions를 구독하지 않고 vanilla subscribe로 변경 메타만
  // 읽는다. feed/settings 모드에서 folderId=null이면 구독 자체가 없고, 활성 폴더와
  // 무관한 단일 세션 변경은 setItems를 호출하지 않는다.
  //
  // 삭제·누락 정리는 서버 페이지네이션 응답의 책임으로 남기고, 여기서는 upsert만 한다.
  useEffect(() => {
    if (!folderId) return;
    const ownerGeneration = scopeGeneration;
    return useSessionStore.subscribe((state, prevState) => {
      if (state.scopeGeneration !== ownerGeneration) return;
      if (state.sessionChangeSerial === prevState.sessionChangeSerial) return;
      const changedId = state.lastChangedSessionId;
      if (changedId) {
        const changed = state.sessions[changedId];
        if (!changed || changed.folderId !== folderId) {
          setItems((prev) => {
            const next = prev.filter((item) => item.agentSessionId !== changedId);
            return next.length === prev.length ? prev : next;
          });
          return;
        }
        setItems((prev) => mergeFolderSessionItems(prev, [changed]));
        return;
      }

      const incoming = Object.values(state.sessions).filter(
        (s) => s.agentSessionId && s.folderId === folderId,
      );
      if (incoming.length === 0) return;
      setItems((prev) => mergeFolderSessionItems(prev, incoming));
    });
  }, [folderId, scopeGeneration]);

  return { items, loading, hasMore, loadMore };
}
