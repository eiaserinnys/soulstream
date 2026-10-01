import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { ApiClient } from '../api/client';
import { selectPlannerInvalidationKeys } from '../lib/planner-invalidation';
import {
  isPlannerStoreScopeCurrent,
  usePlannerStore,
} from '../store/plannerStore';
import { useAuthScopeGeneration } from '../lib/auth-scope';
import {
  moveStarredFolderBefore,
  resolveStarredFolderBoundaryTarget,
  StaleStarredFolderCursorError,
} from '../lib/starred-folder-order';

type StarredRefreshResult = 'refreshed' | 'failed' | 'superseded';

export function usePlannerStarred(api: ApiClient | null, enabled = true) {
  const data = usePlannerStore((state) => state.starred);
  const loading = usePlannerStore((state) => state.loading.starred ?? false);
  const error = usePlannerStore((state) => state.error.starred ?? null);
  const refreshRequired = usePlannerStore((state) => state.starredRefreshRequired);
  const refreshKey = usePlannerStore(
    (state) => selectPlannerInvalidationKeys(state.invalidation).starred,
  );
  const setStarred = usePlannerStore((state) => state.setStarred);
  const setStarredRefreshRequired = usePlannerStore((state) => state.setStarredRefreshRequired);
  const setLoading = usePlannerStore((state) => state.setLoading);
  const setError = usePlannerStore((state) => state.setError);
  const requestGeneration = useRef(0);
  const reorderLock = useRef(false);
  const mounted = useRef(true);
  const [reordering, setReordering] = useState(false);
  const scopeGeneration = useAuthScopeGeneration();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestGeneration.current += 1;
    };
  }, []);
  const refresh = useCallback(async (): Promise<StarredRefreshResult> => {
    const generation = ++requestGeneration.current;
    if (!api || !enabled || !mounted.current || !isPlannerStoreScopeCurrent(scopeGeneration)) {
      return 'superseded';
    }
    setLoading('starred', true);
    setError('starred', null);
    try {
      const result = await api.getStarredFolders();
      if (!isCurrentRequest(requestGeneration, generation, scopeGeneration)) return 'superseded';
      setStarred(result, 'replace');
      setStarredRefreshRequired(false);
      return 'refreshed';
    } catch (cause) {
      if (!isCurrentRequest(requestGeneration, generation, scopeGeneration)) return 'superseded';
      setError('starred', errorText(cause));
      return 'failed';
    } finally {
      if (isCurrentRequest(requestGeneration, generation, scopeGeneration)) setLoading('starred', false);
    }
  }, [api, enabled, scopeGeneration, setError, setLoading, setStarred, setStarredRefreshRequired]);

  const loadMore = useCallback(async () => {
    if (!api || !enabled || !data.nextCursor || reorderLock.current
      || !isPlannerStoreScopeCurrent(scopeGeneration)) return;
    const generation = ++requestGeneration.current;
    setLoading('starred', true);
    setError('starred', null);
    try {
      const result = await api.getStarredFolders(data.nextCursor);
      if (!isCurrentRequest(requestGeneration, generation, scopeGeneration)) return;
      setStarred(result, 'append');
    } catch (cause) {
      if (!isCurrentRequest(requestGeneration, generation, scopeGeneration)) return;
      setError('starred', errorText(cause));
    } finally {
      if (isCurrentRequest(requestGeneration, generation, scopeGeneration)) setLoading('starred', false);
    }
  }, [api, data.nextCursor, enabled, scopeGeneration, setError, setLoading, setStarred]);

  const moveFolderOrder = useCallback(async (
    sourcePageId: string,
    beforePageId: string | null,
  ) => {
    if (!api || !enabled || reorderLock.current || !mounted.current
      || !isPlannerStoreScopeCurrent(scopeGeneration)) return;

    reorderLock.current = true;
    setReordering(true);
    const snapshot = usePlannerStore.getState().starred;
    let rollbackSnapshot = snapshot;
    let optimisticApplied = false;
    let mutationCommitted = false;
    try {
      if (!snapshot.items.some((folder) => folder.page.id === sourcePageId)) {
        throw new StaleStarredFolderCursorError();
      }

      let resolvedBeforePageId = beforePageId;
      let boundaryTargetPageId: string | null = null;
      if (beforePageId === null && snapshot.nextCursor) {
        const boundaryPage = await api.getStarredFolders(snapshot.nextCursor);
        if (!mounted.current || !isPlannerStoreScopeCurrent(scopeGeneration)) return;
        const latest = usePlannerStore.getState().starred;
        if (latest.nextCursor !== snapshot.nextCursor || !sameStarredFolderOrder(
          latest.items,
          snapshot.items,
        )) {
          throw new StaleStarredFolderCursorError();
        }
        boundaryTargetPageId = resolveStarredFolderBoundaryTarget(
          snapshot.items.map((folder) => folder.page.id),
          sourcePageId,
          boundaryPage,
        );
        resolvedBeforePageId = boundaryTargetPageId;
      }

      if (!mounted.current || !isPlannerStoreScopeCurrent(scopeGeneration)) return;
      const latest = usePlannerStore.getState().starred;
      if (latest.nextCursor !== snapshot.nextCursor || !sameStarredFolderOrder(
        latest.items,
        snapshot.items,
      )) {
        throw new StaleStarredFolderCursorError();
      }
      if (resolvedBeforePageId !== null
        && !latest.items.some((folder) => folder.page.id === resolvedBeforePageId)
        && resolvedBeforePageId !== boundaryTargetPageId) {
        throw new StaleStarredFolderCursorError();
      }
      rollbackSnapshot = latest;

      const optimisticItems = moveStarredFolderBefore(
        rollbackSnapshot.items,
        sourcePageId,
        resolvedBeforePageId,
        boundaryTargetPageId !== null,
      );
      if (sameStarredFolderOrder(optimisticItems, rollbackSnapshot.items)) return;

      setStarred({ items: optimisticItems, nextCursor: rollbackSnapshot.nextCursor }, 'replace');
      optimisticApplied = true;
      setError('starred', null);
      await api.moveStarredFolderOrder(sourcePageId, resolvedBeforePageId);
      mutationCommitted = true;
      if (!mounted.current || !isPlannerStoreScopeCurrent(scopeGeneration)) return;
      const current = usePlannerStore.getState().starred;
      setStarred({ items: current.items, nextCursor: null }, 'replace');
      setStarredRefreshRequired(true);
      const refreshed = await refresh();
      if (!mounted.current || !isPlannerStoreScopeCurrent(scopeGeneration)) return;
      if (refreshed === 'failed') {
        const refreshError = usePlannerStore.getState().error.starred;
        throw new Error(refreshError ?? '순서는 저장됐지만 별표 목록을 다시 불러오지 못했습니다. 목록을 새로고침해 주세요.');
      }
    } catch (cause) {
      if (!mounted.current || !isPlannerStoreScopeCurrent(scopeGeneration)) return;
      const message = errorText(cause);
      if (mutationCommitted) {
        setError('starred', message);
        throw cause;
      }
      if (optimisticApplied) setStarred(rollbackSnapshot, 'replace');
      setError('starred', message);
      const refreshed = await refresh();
      if (!mounted.current || !isPlannerStoreScopeCurrent(scopeGeneration)) return;
      if (refreshed === 'failed') {
        const current = usePlannerStore.getState().starred;
        setStarred({ items: current.items, nextCursor: null }, 'replace');
        setStarredRefreshRequired(true);
      }
      setError('starred', message);
      throw cause;
    } finally {
      reorderLock.current = false;
      if (mounted.current) setReordering(false);
    }
  }, [api, enabled, refresh, setError, setStarred, setStarredRefreshRequired]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  return {
    data,
    loading,
    error,
    refresh,
    loadMore,
    moveFolderOrder,
    refreshRequired,
    reordering,
  };
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function sameStarredFolderOrder(
  left: readonly { page: { id: string } }[],
  right: readonly { page: { id: string } }[],
): boolean {
  return left.length === right.length
    && left.every((folder, index) => folder.page.id === right[index]?.page.id);
}

function isCurrentRequest(
  requestGeneration: MutableRefObject<number>,
  generation: number,
  scopeGeneration: string,
): boolean {
  return generation === requestGeneration.current
    && isPlannerStoreScopeCurrent(scopeGeneration);
}
