import { useCallback, useMemo } from 'react';
import type { ApiClient } from '../api/client';
import { captureAuthScope, isAuthScopeCurrent, useAuthScopeGeneration } from '../lib/auth-scope';
import { useSessionStore } from '../store/sessionStore';

export function useFeedPagination(api: ApiClient | null) {
  const scopeGeneration = useAuthScopeGeneration();
  const scope = useMemo(() => captureAuthScope(), [scopeGeneration]);
  const feedPage = useSessionStore((state) => state.feedPage);

  const requestOnePage = useCallback(async (fromStatus: 'idle' | 'error') => {
    if (!api || !isAuthScopeCurrent(scope)) return;
    const current = useSessionStore.getState();
    if (
      current.catalogLoadState !== 'ready'
      || !current.feedPage.hasMore
      || !current.feedPage.nextCursor
      || current.feedPage.status !== fromStatus
    ) return;
    const cursor = current.feedPage.nextCursor;
    const expectedPage = current.beginFeedPage(fromStatus);
    if (!expectedPage) return;
    try {
      const page = await api.getFeedPage(cursor);
      if (!isAuthScopeCurrent(scope)) return;
      useSessionStore.getState().appendFeedPage(page, expectedPage);
    } catch (error) {
      if (!isAuthScopeCurrent(scope)) return;
      useSessionStore.getState().failFeedPage(expectedPage);
      console.warn('[useFeedPagination] page fetch failed:', error);
    }
  }, [api, scope]);

  const loadMore = useCallback(() => requestOnePage('idle'), [requestOnePage]);
  const retryFeedPage = useCallback(() => requestOnePage('error'), [requestOnePage]);

  return { feedPage, loadMore, retryFeedPage };
}
