import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { ApiClient } from '../api/client';
import type { PageReadResult } from '../api/pageEndpoints';
import type { PlannerFolderDetail } from '../api/plannerTypes';
import { selectPlannerInvalidationKeys } from '../lib/planner-invalidation';
import {
  capturePlannerProjection,
  replaceFolderProjection,
} from '../lib/planner-mutation-projection';
import {
  selectDaily,
  selectProject,
  selectFolderChildren,
  selectFolderSessions,
  usePlannerStore,
  selectPlannerFolder,
  isPlannerStoreScopeCurrent,
  setPlannerProjectionForScope,
} from '../store/plannerStore';
import { replaceEqualDeep } from '../lib/structural-sharing';
import { useAuthScopeGeneration } from '../lib/auth-scope';

export { usePlannerStarred } from './usePlannerStarred';

export function usePlannerPageDetail(
  api: ApiClient | null,
  pageId: string | null,
  enabled = true,
) {
  const resolvedPageId = pageId ?? '';
  const folder = usePlannerStore(selectPlannerFolder(resolvedPageId));
  const refreshKey = usePlannerStore(
    (state) => selectPlannerInvalidationKeys(state.invalidation).pageDetail,
  );
  const requestGeneration = useRef(0);
  const scopeGeneration = useAuthScopeGeneration();
  const ownerKey = `${scopeGeneration}\u0000${resolvedPageId}`;
  const [local, setLocal] = useState(() => emptyPageDetailState(ownerKey));
  const current = local.ownerKey === ownerKey ? local : emptyPageDetailState(ownerKey);

  const refresh = useCallback(async () => {
    const generation = ++requestGeneration.current;
    if (!api || !pageId || !enabled) {
      setLocal(emptyPageDetailState(ownerKey));
      return;
    }
    setLocal((previous) => ({
      ownerKey,
      data: previous.ownerKey === ownerKey ? previous.data : undefined,
      loading: true,
      error: null,
    }));
    try {
      const result = await api.getPage(pageId);
      if (!isCurrentRequest(requestGeneration, generation, scopeGeneration)) return;
      setLocal((previous) => previous.ownerKey === ownerKey ? {
        ...previous,
        data: replaceEqualDeep(previous.data, result),
      } : previous);
      const store = usePlannerStore.getState();
      const currentFolder = selectPlannerFolder(pageId)(store);
      if (currentFolder) {
        const page = replaceEqualDeep(currentFolder.page, result.page);
        const blocks = replaceEqualDeep(currentFolder.blocks, result.blocks);
        if (page === currentFolder.page && blocks === currentFolder.blocks) return;
        if (!isCurrentRequest(requestGeneration, generation, scopeGeneration)) return;
        setPlannerProjectionForScope(scopeGeneration, replaceFolderProjection(
          capturePlannerProjection(store),
          { ...currentFolder, page, blocks },
        ));
      }
    } catch (cause) {
      if (!isCurrentRequest(requestGeneration, generation, scopeGeneration)) return;
      setLocal((previous) => previous.ownerKey === ownerKey
        ? { ...previous, error: errorText(cause) }
        : previous);
    } finally {
      if (isCurrentRequest(requestGeneration, generation, scopeGeneration)) {
        setLocal((previous) => previous.ownerKey === ownerKey
          ? { ...previous, loading: false }
          : previous);
      }
    }
  }, [api, enabled, ownerKey, pageId, scopeGeneration]);

  useEffect(() => {
    requestGeneration.current += 1;
    setLocal(emptyPageDetailState(ownerKey));
  }, [ownerKey]);

  useEffect(() => {
    void refresh();
    return () => { requestGeneration.current += 1; };
  }, [refresh, refreshKey]);

  return {
    data: current.data,
    folder,
    loading: current.loading,
    error: current.error,
    refresh,
  };
}

export function usePlannerDaily(
  api: ApiClient | null,
  date: string,
  enabled = true,
) {
  const data = usePlannerStore(selectDaily(date));
  const loading = usePlannerStore((state) => state.loading[`daily:${date}`] ?? false);
  const error = usePlannerStore((state) => state.error[`daily:${date}`] ?? null);
  const refreshKey = usePlannerStore(
    (state) => selectPlannerInvalidationKeys(state.invalidation).daily,
  );
  const setDaily = usePlannerStore((state) => state.setDaily);
  const setLoading = usePlannerStore((state) => state.setLoading);
  const setError = usePlannerStore((state) => state.setError);
  const requestGeneration = useRef(0);
  const scopeGeneration = useAuthScopeGeneration();
  useEffect(() => () => { requestGeneration.current += 1; }, []);

  const refresh = useCallback(async () => {
    const generation = ++requestGeneration.current;
    if (!api || !enabled) return;
    const key = `daily:${date}`;
    setLoading(key, true);
    setError(key, null);
    try {
      const result = await api.getPlannerToday(date);
      if (!isCurrentRequest(requestGeneration, generation, scopeGeneration)) return;
      setDaily(date, result);
    } catch (cause) {
      if (!isCurrentRequest(requestGeneration, generation, scopeGeneration)) return;
      setError(key, errorText(cause));
    } finally {
      if (isCurrentRequest(requestGeneration, generation, scopeGeneration)) setLoading(key, false);
    }
  }, [api, date, enabled, scopeGeneration, setDaily, setError, setLoading]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  return { data, loading, error, refresh };
}

export function usePlannerFolderDetail(
  api: ApiClient | null,
  folderId: string | null,
  enabled = true,
) {
  const scopeGeneration = useAuthScopeGeneration();
  const ownerKey = scopeGeneration + ':' + (folderId ?? '') + ':includeCompleted=false';
  const [local, setLocal] = useState<{
    ownerKey: string;
    data: PlannerFolderDetail | undefined;
    loading: boolean;
    error: string | null;
  }>({ ownerKey, data: undefined, loading: false, error: null });
  const current = local.ownerKey === ownerKey
    ? local
    : { ownerKey, data: undefined, loading: false, error: null };
  const requestGeneration = useRef(0);
  const refreshKey = usePlannerStore(
    (state) => selectPlannerInvalidationKeys(state.invalidation).project,
  );

  const refresh = useCallback(async () => {
    const generation = ++requestGeneration.current;
    if (!api || !folderId || !enabled) return;
    setLocal((previous) => ({
      ownerKey,
      data: previous.ownerKey === ownerKey ? previous.data : undefined,
      loading: true,
      error: null,
    }));
    try {
      const data = await api.getPlannerFolder(folderId,{includeCompleted:false});
      if (isCurrentRequest(requestGeneration, generation, scopeGeneration)) {
        setLocal({ ownerKey, data, loading: false, error: null });
      }
    } catch (cause) {
      if (isCurrentRequest(requestGeneration, generation, scopeGeneration)) {
        setLocal((previous) => ({
          ownerKey,
          data: previous.ownerKey === ownerKey ? previous.data : undefined,
          loading: false,
          error: errorText(cause),
        }));
      }
    }
  }, [api, enabled, folderId, ownerKey, scopeGeneration]);

  const loadMoreSubfolders = useCallback(async () => {
    const cursor = current.data?.subfolders.nextCursor;
    if (!api || !folderId || !enabled || !cursor) return;
    const generation = requestGeneration.current;
    try {
      const page = await api.getPlannerFolderSubfolders(folderId, cursor);
      if (!isCurrentRequest(requestGeneration, generation, scopeGeneration)) return;
      setLocal((previous) => {
        if (previous.ownerKey !== ownerKey || !previous.data) return previous;
        return {
          ...previous,
          data: {
            ...previous.data,
            subfolders: {
              items: [...previous.data.subfolders.items, ...page.items],
              nextCursor: page.nextCursor,
            },
          },
        };
      });
    } catch (cause) {
      if (isCurrentRequest(requestGeneration, generation, scopeGeneration)) {
        setLocal((previous) => ({ ...previous, error: errorText(cause) }));
      }
    }
  }, [api, current.data?.subfolders.nextCursor, enabled, folderId, ownerKey, scopeGeneration]);

  useEffect(() => {
    requestGeneration.current += 1;
    setLocal({ ownerKey, data: undefined, loading: false, error: null });
  }, [ownerKey]);
  useEffect(() => {
    void refresh();
    return () => { requestGeneration.current += 1; };
  }, [refresh, refreshKey]);

  return {
    data: current.data,
    subfolders: current.data?.subfolders,
    loading: current.loading,
    error: current.error,
    refresh,
    loadMoreSubfolders,
  };
}

export function usePlannerFolderSessions(
  api: ApiClient | null,
  pageId: string | null,
  enabled = true,
) {
  const resolvedPageId = pageId ?? '';
  const data = usePlannerStore(selectFolderSessions(resolvedPageId));
  const key = `runs:${resolvedPageId}`;
  const loading = usePlannerStore((state) => state.loading[key] ?? false);
  const error = usePlannerStore((state) => state.error[key] ?? null);
  const refreshKey = usePlannerStore(
    (state) => selectPlannerInvalidationKeys(state.invalidation).runHistory,
  );
  const setFolderSessions = usePlannerStore((state) => state.setFolderSessions);
  const setLoading = usePlannerStore((state) => state.setLoading);
  const setError = usePlannerStore((state) => state.setError);
  const requestGeneration = useRef(0);
  const scopeGeneration = useAuthScopeGeneration();
  useEffect(() => () => { requestGeneration.current += 1; }, []);

  const refresh = useCallback(async () => {
    const generation = ++requestGeneration.current;
    if (!api || !pageId || !enabled) return;
    setLoading(key, true);
    setError(key, null);
    try {
      const result = await api.getPlannerFolderSessions(pageId);
      if (!isCurrentRequest(requestGeneration, generation, scopeGeneration)) return;
      setFolderSessions(pageId, result, 'replace');
    } catch (cause) {
      if (!isCurrentRequest(requestGeneration, generation, scopeGeneration)) return;
      setError(key, errorText(cause));
    } finally {
      if (isCurrentRequest(requestGeneration, generation, scopeGeneration)) setLoading(key, false);
    }
  }, [api, enabled, key, pageId, scopeGeneration, setError, setLoading, setFolderSessions]);

  const loadMore = useCallback(async () => {
    if (!api || !pageId || !enabled || !data?.nextCursor) return;
    const generation = ++requestGeneration.current;
    setLoading(key, true);
    setError(key, null);
    try {
      const result = await api.getPlannerFolderSessions(pageId, data.nextCursor);
      if (!isCurrentRequest(requestGeneration, generation, scopeGeneration)) return;
      setFolderSessions(pageId, result, 'append');
    } catch (cause) {
      if (!isCurrentRequest(requestGeneration, generation, scopeGeneration)) return;
      setError(key, errorText(cause));
    } finally {
      if (isCurrentRequest(requestGeneration, generation, scopeGeneration)) setLoading(key, false);
    }
  }, [api, data?.nextCursor, enabled, key, pageId, scopeGeneration, setError, setLoading, setFolderSessions]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  return {
    data,
    loading,
    error,
    refresh,
    loadMore,
  };
}

export function usePlannerDailyHistory(
  api: ApiClient | null,
  before: string,
  enabled = true,
) {
  const requestGeneration = useRef(0);
  const scopeGeneration = useAuthScopeGeneration();
  const ownerKey = `${scopeGeneration}\u0000${before}`;
  const [local, setLocal] = useState(() => ({
    ownerKey,
    dates: [] as string[],
    loading: false,
    error: null as string | null,
  }));
  const current = local.ownerKey === ownerKey
    ? local
    : { ownerKey, dates: [] as string[], loading: false, error: null as string | null };

  useEffect(() => {
    const generation = ++requestGeneration.current;
    setLocal({ ownerKey, dates: [], loading: Boolean(api && enabled), error: null });
    if (!api || !enabled) return;
    let active = true;
    void api.getDailyHistory(before).then((result) => {
      if (active && isCurrentRequest(requestGeneration, generation, scopeGeneration)) {
        setLocal((previous) => previous.ownerKey === ownerKey
          ? { ...previous, dates: result.dates }
          : previous);
      }
    }).catch((cause: unknown) => {
      if (active && isCurrentRequest(requestGeneration, generation, scopeGeneration)) {
        setLocal((previous) => previous.ownerKey === ownerKey
          ? { ...previous, error: errorText(cause) }
          : previous);
      }
    }).finally(() => {
      if (active && isCurrentRequest(requestGeneration, generation, scopeGeneration)) {
        setLocal((previous) => previous.ownerKey === ownerKey
          ? { ...previous, loading: false }
          : previous);
      }
    });
    return () => { active = false; };
  }, [api, before, enabled, ownerKey, scopeGeneration]);

  return { dates: current.dates, loading: current.loading, error: current.error };
}

function emptyPageDetailState(ownerKey: string): {
  ownerKey: string;
  data: PageReadResult | undefined;
  loading: boolean;
  error: string | null;
} {
  return { ownerKey, data: undefined, loading: false, error: null };
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isCurrentRequest(
  requestGeneration: MutableRefObject<number>,
  generation: number,
  scopeGeneration: string,
): boolean {
  return generation === requestGeneration.current
    && isPlannerStoreScopeCurrent(scopeGeneration);
}
