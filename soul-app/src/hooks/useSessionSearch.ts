import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ApiClient,
  SearchNavigationResult,
  SessionMessageSearchStatus,
  SessionMessageSearchResult,
  SessionSearchProjection,
} from '../api/client';
import type { Session } from '../api/types';
import { useSearchStore, type SearchFilters } from '../store/searchStore';
import { useSessionStore } from '../store/sessionStore';
import {
  createUiUsageFlowId,
  recordUiUsageEvent,
} from '../lib/ui-usage-events';

const INITIAL_TOP_K = 20;
const MAX_TOP_K = 100;

export function useSessionSearch(api: ApiClient | null) {
  const query = useSearchStore((state) => state.query);
  const scope = useSearchStore((state) => state.scope);
  const filters = useSearchStore((state) => state.filters);
  const [sessionResults, setSessionResults] = useState<Session[]>([]);
  const [messageResults, setMessageResults] =
    useState<SessionMessageSearchResult[]>([]);
  const [sessionMatches, setSessionMatches] =
    useState<SessionSearchProjection[]>([]);
  const [searchStatus, setSearchStatus] =
    useState<SessionMessageSearchStatus | null>(null);
  const [navigationResults, setNavigationResults] =
    useState<SearchNavigationResult[]>([]);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [messageLoading, setMessageLoading] = useState(false);
  const [expansionPending, setExpansionPending] = useState(false);
  const [expansionFailed, setExpansionFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [topK, setTopK] = useState(INITIAL_TOP_K);
  const [sessionHasMore, setSessionHasMore] = useState(false);
  const [messageHasMore, setMessageHasMore] = useState(false);
  const [searchFlowId, setSearchFlowId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sequenceRef = useRef(0);

  useEffect(() => useSearchStore.subscribe((state, previousState) => {
    if (
      state.query !== previousState.query ||
      state.scope !== previousState.scope ||
      state.filters !== previousState.filters
    ) {
      abortRef.current?.abort();
    }
  }), []);

  useEffect(() => {
    setTopK(INITIAL_TOP_K);
  }, [filters, query, scope]);

  useEffect(() => {
    abortRef.current?.abort();
    const sequence = ++sequenceRef.current;
    const normalizedQuery = query.trim();
    if (!api || !normalizedQuery) {
      setSessionResults([]);
      setMessageResults([]);
      setSessionMatches([]);
      setSearchStatus(null);
      setNavigationResults([]);
      setSessionHasMore(false);
      setMessageHasMore(false);
      setSessionLoading(false);
      setMessageLoading(false);
      setExpansionPending(false);
      setExpansionFailed(false);
      setError(null);
      setSearchFlowId(null);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    const isCurrent = () => sequence === sequenceRef.current && !controller.signal.aborted;
    setSessionLoading(scope === 'sessions');
    setMessageLoading(scope !== 'sessions');
    setExpansionPending(false);
    setExpansionFailed(false);
    setSessionResults([]);
    setMessageResults([]);
    setNavigationResults([]);
    setSessionMatches([]);
    setSearchStatus(null);
    setError(null);
    let started = false;
    let finished = false;
    let flowId: string | null = null;
    let startedAt = 0;
    const timer = setTimeout(() => {
      started = true;
      startedAt = Date.now();
      flowId = createUiUsageFlowId();
      setSearchFlowId(flowId);
      if (flowId) {
        recordUiUsageEvent({
          type: 'search_submit',
          flowId,
          attrs: {
            queryText: query,
            trigger: 'typing',
            scope,
          },
        });
      }
      let resultCount = 0;
      let flowStatus: 'ok' | 'error' | 'aborted' = 'ok';
      const requests: Array<Promise<'ok' | 'error' | 'aborted'>> = [];
      const sessionFilters = buildSessionSearchFilters(filters);
      if (scope === 'sessions') {
        requests.push(api.searchSessions({
          query: normalizedQuery,
          folderId: filters.folderId,
          nodeId: filters.nodeId,
          statuses: filters.statuses,
          backends: filters.backends,
          updatedAfter: sessionFilters.updatedAfter,
          limit: topK,
        }, controller.signal).then((page) => {
          if (!isCurrent()) return 'aborted';
          useSessionStore.getState().mergeSessions(page.sessions);
          resultCount += page.sessions.length;
          setSessionResults(page.sessions);
          setSessionHasMore(page.hasMore && topK < MAX_TOP_K);
          return 'ok';
        }).catch((cause) => {
          if (isAbortError(cause)) return 'aborted';
          setError(errorMessage(cause));
          return 'error';
        }).finally(() => {
          if (isCurrent()) setSessionLoading(false);
        }));
      } else {
        setSessionResults([]);
        setSessionHasMore(false);
        setSessionMatches([]);
      }

      if (scope !== 'sessions') {
        const searchParams = {
          query: normalizedQuery,
          topK,
          eventCategories: filters.eventCategories,
          searchSessionId: true,
          includeSessionResults: true,
          includeTurnSummaries: filters.includeTurnSummaries,
          includeHighlight: filters.includeHighlight,
          includeStory: filters.includeStory,
          sessionFilters,
        };
        requests.push(api.searchSessionMessages({
          ...searchParams,
          sessionSearchMode: 'lexical',
        }, controller.signal).then(async (lexical) => {
          if (!isCurrent()) return 'aborted' as const;
          const shouldSkipExpansionWithoutHydration = hasExactNormalizedSessionTitle(
            normalizedQuery,
            lexical.sessionResults ?? [],
          );
          const expansionAbort = createChildAbortController(controller.signal);
          const expandedPromise = shouldSkipExpansionWithoutHydration
            ? null
            : api.searchSessionMessages({
              ...searchParams,
              sessionSearchMode: 'expanded',
            }, expansionAbort.controller.signal);
          if (expandedPromise) {
            void expandedPromise.catch(() => undefined);
            setExpansionPending(true);
            setMessageLoading(false);
          }
          const visible = resolveVisibleSearchPayload(
            lexical,
            api,
            isCurrent,
            controller.signal,
          );
          if (!visible || !isCurrent()) {
            expansionAbort.controller.abort();
            expansionAbort.dispose();
            return 'aborted' as const;
          }
          setSessionMatches(visible.projections);
          setMessageResults(visible.messages);
          setNavigationResults(lexical.navigationResults ?? []);
          setSearchStatus(lexical.searchStatus);
          setMessageHasMore(
            (lexical.results.length >= topK || (lexical.sessionResults?.length ?? 0) >= topK)
              && topK < MAX_TOP_K,
          );
          resultCount = visible.projections.length + visible.messages.length
            + (lexical.navigationResults?.length ?? 0);
          setMessageLoading(false);

          if (hasExactNormalizedSessionTitle(normalizedQuery, visible.projections)) {
            expansionAbort.controller.abort();
            expansionAbort.dispose();
            setExpansionPending(false);
            return 'ok' as const;
          }
          if (!expandedPromise) {
            expansionAbort.dispose();
            return 'ok' as const;
          }
          try {
            const expanded = await expandedPromise;
            if (!isCurrent()) return 'aborted' as const;
            if (
              expanded.searchStatus?.queryExpansion.status === 'partial'
              || expanded.searchStatus?.search?.status === 'partial'
            ) {
              flowStatus = 'error';
              setExpansionFailed(true);
              return 'error' as const;
            }
            const expandedVisible = resolveVisibleSearchPayload(
              expanded,
              api,
              isCurrent,
              controller.signal,
            );
            if (!expandedVisible || !isCurrent()) return 'aborted' as const;
            setSessionMatches(preserveSessionAnchors(
              visible.projections,
              expandedVisible.projections,
            ));
            setMessageResults(expandedVisible.messages);
            setNavigationResults(expanded.navigationResults ?? []);
            setSearchStatus(expanded.searchStatus);
            setMessageHasMore(
              (expanded.results.length >= topK || (expanded.sessionResults?.length ?? 0) >= topK)
                && topK < MAX_TOP_K,
            );
            resultCount = expandedVisible.projections.length + expandedVisible.messages.length
              + (expanded.navigationResults?.length ?? 0);
          } catch (cause) {
            if (isAbortError(cause)) return 'aborted' as const;
            if (isCurrent()) {
              flowStatus = 'error';
              setExpansionFailed(true);
            }
          } finally {
            expansionAbort.dispose();
            if (isCurrent()) setExpansionPending(false);
          }
          return flowStatus === 'error' ? 'error' as const : 'ok' as const;
        }).catch((cause) => {
          if (isAbortError(cause) || !isCurrent()) return 'aborted';
          flowStatus = 'error';
          setExpansionPending(false);
          setError(errorMessage(cause));
          return 'error';
        }).finally(() => {
          if (isCurrent()) setMessageLoading(false);
        }));
      } else {
        setMessageResults([]);
        setNavigationResults([]);
        setSessionMatches([]);
        setSearchStatus(null);
        setMessageHasMore(false);
      }
      void Promise.all(requests).then((results) => {
        if (finished) return;
        finished = true;
        if (!flowId) return;
        const status = controller.signal.aborted || results.includes('aborted')
          ? 'aborted'
          : flowStatus;
        recordUiUsageEvent({
          type: 'search_result',
          flowId,
          attrs: {
            status,
            durationMs: Date.now() - startedAt,
            ...(status === 'ok' ? { resultCount } : {}),
            ...(status === 'error' ? { errorCode: 'search_request' } : {}),
          },
        });
      });
    }, 300);

    return () => {
      clearTimeout(timer);
      controller.abort();
      if (started && !finished && flowId) {
        finished = true;
        recordUiUsageEvent({
          type: 'search_result',
          flowId,
          attrs: {
            status: 'aborted',
            durationMs: Date.now() - startedAt,
          },
        });
      }
    };
  }, [api, filters, query, scope, topK]);

  const loadMore = useCallback(() => {
    if (!sessionHasMore && !messageHasMore) return;
    setTopK((value) => Math.min(MAX_TOP_K, value + INITIAL_TOP_K));
  }, [messageHasMore, sessionHasMore]);

  return {
    sessionResults,
    sessionMatches,
    searchStatus,
    messageResults,
    navigationResults,
    sessionLoading,
    messageLoading,
    loading: sessionLoading || messageLoading,
    expansionPending,
    expansionFailed,
    error,
    hasMore: sessionHasMore || messageHasMore,
    loadMore,
    searchFlowId,
  };
}

function resolveVisibleSearchPayload(
  payload: Awaited<ReturnType<ApiClient['searchSessionMessages']>>,
  api: ApiClient,
  isCurrent: () => boolean,
  signal: AbortSignal,
): { projections: SessionSearchProjection[]; messages: SessionMessageSearchResult[] } | null {
  const projections = payload.sessionResults ?? [];
  const sessionIds = [...new Set([
    ...projections.map((result) => result.sessionId),
    ...payload.results.map((result) => result.sessionId),
  ])];
  if (sessionIds.length > 0) {
    void api.getSessionsByIds(sessionIds, signal).then((hydrated) => {
      if (isCurrent()) useSessionStore.getState().mergeSessions(hydrated);
    }).catch(() => undefined);
  }
  if (!isCurrent()) return null;
  const visibleProjectionIds = new Set(projections.map((result) => result.sessionId));
  const messages = payload.results.filter((result) => {
    if (visibleProjectionIds.has(result.sessionId)) return false;
    return true;
  });
  return { projections, messages };
}

function createChildAbortController(parentSignal: AbortSignal): {
  controller: AbortController;
  dispose(): void;
} {
  const controller = new AbortController();
  const abortChild = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) abortChild();
  else parentSignal.addEventListener('abort', abortChild, { once: true });
  return {
    controller,
    dispose: () => parentSignal.removeEventListener('abort', abortChild),
  };
}

function hasExactNormalizedSessionTitle(
  query: string,
  results: readonly SessionSearchProjection[],
): boolean {
  const normalizedQuery = normalizeExactTitle(query);
  return normalizedQuery.length > 0 && results.some(
    (result) => normalizeExactTitle(result.title) === normalizedQuery,
  );
}

function normalizeExactTitle(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '');
}

function preserveSessionAnchors(
  lexical: readonly SessionSearchProjection[],
  expanded: readonly SessionSearchProjection[],
): SessionSearchProjection[] {
  const lexicalById = new Map(lexical.map((session) => [session.sessionId, session]));
  return expanded.map((session) => {
    const initial = lexicalById.get(session.sessionId);
    return initial === undefined
      ? session
      : {
          ...session,
          bestMatch: initial.bestMatch,
          sessionUrl: initial.sessionUrl,
        };
  });
}

function buildSessionSearchFilters(filters: SearchFilters) {
  return {
    folderId: filters.folderId,
    nodeId: filters.nodeId,
    statuses: filters.statuses,
    backends: filters.backends,
    ...(filters.period === 'all'
      ? {}
      : { updatedAfter: new Date(periodStart(filters.period)).toISOString() }),
  };
}

function periodStart(period: Exclude<SearchFilters['period'], 'all'>): number {
  const now = new Date();
  if (period === 'today') {
    return new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    ).getTime();
  }
  const days = period === '7d' ? 7 : 30;
  return now.getTime() - days * 24 * 60 * 60 * 1000;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
