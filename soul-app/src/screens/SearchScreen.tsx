import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  FlatList,
  Text,
  TextInput,
  View,
  type ListRenderItemInfo,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import {
  createApiClient,
  type SearchNavigationResult,
  type SessionMessageSearchResult,
  type SessionSearchProjection,
} from '../api/client';
import type { Session } from '../api/types';
import { SessionCardById } from '../components/SessionCardById';
import { AppGlassPressable } from '../components/AppGlassCard';
import { GlassButton } from '../components/GlassSurface';
import { SearchFilterChips } from '../components/search/SearchFilterChips';
import { SearchFilterModal } from '../components/search/SearchFilterModal';
import { SearchContentScopeToggles } from '../components/search/SearchContentScopeToggles';
import { SearchResultMessageRow } from '../components/search/SearchResultMessageRow';
import { SearchScopeSegment } from '../components/search/SearchScopeSegment';
import { SessionSearchField } from '../components/search/SessionSearchField';
import { useSessionSearch } from '../hooks/useSessionSearch';
import { getSessionDisplayName } from '../lib/session-display-name';
import { SESSION_FEED_VIRTUALIZATION } from '../lib/session-feed-virtualization';
import { useSearchStore } from '../store/searchStore';
import { useSessionStore } from '../store/sessionStore';
import { useSettingsStore } from '../store/settingsStore';
import { useTokens } from '../theme';
import { makeSearchScreenStyles } from './SearchScreen.styles';
import { SearchEmpty, SearchRecents } from './SearchScreenSupport';
import { recordUiUsageEvent } from '../lib/ui-usage-events';

type ResultEntry =
  | { kind: 'session'; key: string; session: Session; searchMatch?: SessionSearchProjection }
  | { kind: 'projection'; key: string; match: SessionSearchProjection }
  | { kind: 'message'; key: string; result: SessionMessageSearchResult }
  | { kind: 'navigation'; key: string; result: SearchNavigationResult };

type SearchRow =
  | { kind: 'heading'; key: string; title: string; count: number }
  | ResultEntry;

let nextStoryOpenRequestId = 0;

export function SearchScreen({
  tablet = false,
  showInput = true,
  autoFocus = true,
  onOpenSession,
  onOpenFolder,
}: {
  tablet?: boolean;
  showInput?: boolean;
  autoFocus?: boolean;
  onOpenSession(
    sessionId: string,
    eventId?: number,
    storyOpenRequestId?: number,
  ): void;
  onOpenFolder?(result: SearchNavigationResult): void;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeSearchScreenStyles(t), [t]);
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const api = useMemo(
    () => serverUrl ? createApiClient(serverUrl) : null,
    [serverUrl],
  );
  const query = useSearchStore((state) => state.query);
  const scope = useSearchStore((state) => state.scope);
  const filters = useSearchStore((state) => state.filters);
  const recentQueries = useSearchStore((state) => state.recentQueries);
  const recentSessionIds = useSearchStore((state) => state.recentSessionIds);
  const focusRequestId = useSearchStore((state) => state.focusRequestId);
  const activationRequestId = useSearchStore(
    (state) => state.activationRequestId,
  );
  const selectedResultIndex = useSearchStore(
    (state) => state.selectedResultIndex,
  );
  const folders = useSessionStore((state) => state.catalog.folders);
  const sessions = useSessionStore((state) => state.sessions);
  const inputRef = useRef<TextInput>(null);
  const listRef = useRef<FlatList<SearchRow>>(null);
  const [filterVisible, setFilterVisible] = useState(false);
  const [pinnedSelectionEntry, setPinnedSelectionEntry] =
    useState<ResultEntry | null>(null);
  const {
    sessionResults,
    sessionMatches,
    searchStatus,
    messageResults,
    navigationResults,
    loading,
    expansionPending,
    expansionFailed,
    error,
    hasMore,
    loadMore,
    searchFlowId,
  } = useSessionSearch(api);

  const nodeIds = useMemo(
    () => unique(Object.values(sessions).flatMap((session) =>
      session.nodeId ? [session.nodeId] : []
    )),
    [sessions],
  );
  const backends = useMemo(
    () => unique(Object.values(sessions).flatMap((session) =>
      session.backend ? [session.backend] : []
    )),
    [sessions],
  );
  const serverResultEntries = useMemo<ResultEntry[]>(() => {
    const matchBySessionId = new Map(sessionMatches.map((match) => [match.sessionId, match]));
    const metadataSessionIds = new Set(sessionResults.map((session) => session.agentSessionId));
    const metadataEntries = sessionResults.map((session) => ({
      kind: 'session' as const,
      key: `session:${session.agentSessionId}`,
      session,
      searchMatch: matchBySessionId.get(session.agentSessionId),
    }));
    const contentEntries = sessionMatches.flatMap((match) => {
      if (metadataSessionIds.has(match.sessionId)) return [];
      const session = sessions[match.sessionId];
      return [session ? {
        kind: 'session' as const,
        key: `session:${session.agentSessionId}`,
        session,
        searchMatch: match,
      } : {
        kind: 'projection' as const,
        key: `session:${match.sessionId}`,
        match,
      }];
    });
    return [
    ...metadataEntries,
    ...contentEntries,
    ...messageResults.map((result) => ({
      kind: 'message' as const,
      key: `message:${result.sessionId}:${result.eventId}:${result.matchSource}`,
      result,
    })),
    ...navigationResults.map((result) => ({
      kind: 'navigation' as const,
      key: `navigation:${result.kind}:${result.id}`,
      result,
    })),
    ];
  }, [messageResults, navigationResults, sessionMatches, sessionResults, sessions]);
  const resultEntries = useMemo(() => {
    if (
      !pinnedSelectionEntry
      || serverResultEntries.some((entry) => entry.key === pinnedSelectionEntry.key)
    ) return serverResultEntries;
    return [...serverResultEntries, pinnedSelectionEntry];
  }, [pinnedSelectionEntry, serverResultEntries]);
  const rows = useMemo<SearchRow[]>(() => [
    ...(resultEntries.some((entry) => entry.kind === 'session' || entry.kind === 'projection')
      ? [
          {
            kind: 'heading' as const,
            key: 'heading:sessions',
            title: '세션',
            count: resultEntries.filter((entry) => entry.kind === 'session' || entry.kind === 'projection').length,
          },
          ...resultEntries.filter((entry) => entry.kind === 'session' || entry.kind === 'projection'),
        ]
      : []),
    ...(messageResults.length > 0
      ? [
          {
            kind: 'heading' as const,
            key: 'heading:messages',
            title: '대화 내용',
            count: messageResults.length,
          },
          ...resultEntries.filter((entry) => entry.kind === 'message'),
        ]
      : []),
    ...(navigationResults.length > 0
      ? [
          {
            kind: 'heading' as const,
            key: 'heading:navigation',
            title: '폴더',
            count: navigationResults.length,
          },
          ...resultEntries.filter((entry) => entry.kind === 'navigation'),
        ]
      : []),
  ], [
    resultEntries,
    messageResults.length,
    navigationResults.length,
  ]);
  const searchIncomplete = searchStatus?.search?.status === 'partial'
    || searchStatus?.queryExpansion.status === 'partial'
    || expansionFailed;

  const openResult = useCallback((
    sessionId: string,
    eventId?: number,
    storyOpenRequestId?: number,
  ) => {
    const store = useSearchStore.getState();
    store.rememberQuery(store.query);
    store.rememberSession(sessionId);
    if (storyOpenRequestId === undefined) {
      onOpenSession(sessionId, eventId);
      return;
    }
    onOpenSession(sessionId, eventId, storyOpenRequestId);
  }, [onOpenSession]);

  const openEntry = useCallback((entry: ResultEntry) => {
    const rank = resultEntries.findIndex((candidate) => candidate.key === entry.key);
    const target = searchResultTarget(entry);
    if (searchFlowId && rank >= 0) {
      recordUiUsageEvent({
        type: 'search_result_open',
        target,
        from: { kind: 'view', id: 'search' },
        entry: 'search',
        flowId: searchFlowId,
        attrs: { rank, resultKind: entry.kind },
      });
    }
    if (entry.kind === 'session' || entry.kind === 'projection') {
      const sessionId = entry.kind === 'session' ? entry.session.agentSessionId : entry.match.sessionId;
      const match = entry.kind === 'session' ? entry.searchMatch?.bestMatch : entry.match.bestMatch;
      if (match?.matchSource === 'highlight' || match?.matchSource === 'story') {
        nextStoryOpenRequestId += 1;
        openResult(sessionId, undefined, nextStoryOpenRequestId);
      } else {
        openResult(sessionId, match?.eventId ?? undefined);
      }
    } else if (entry.kind === 'message') {
      if (
        entry.result.matchSource === 'highlight'
        || entry.result.matchSource === 'story'
      ) {
        nextStoryOpenRequestId += 1;
        openResult(
          entry.result.sessionId,
          undefined,
          nextStoryOpenRequestId,
        );
        return;
      }
      openResult(entry.result.sessionId, entry.result.eventId);
    } else {
      useSearchStore.getState().rememberQuery(useSearchStore.getState().query);
      onOpenFolder?.(entry.result);
    }
  }, [onOpenFolder, openResult, resultEntries, searchFlowId]);

  const previousResultEntriesRef = useRef(resultEntries);
  const previousSelectedIndexRef = useRef(selectedResultIndex);
  const selectedEntryKeyRef = useRef<string | undefined>(
    resultEntries[selectedResultIndex]?.key,
  );
  const selectionContextRef = useRef({ query, scope, filters });
  const selectionContextResetPendingRef = useRef(false);
  useLayoutEffect(() => {
    const contextChanged = selectionContextRef.current.query !== query
      || selectionContextRef.current.scope !== scope
      || selectionContextRef.current.filters !== filters;
    if (contextChanged) {
      selectionContextRef.current = { query, scope, filters };
      selectedEntryKeyRef.current = undefined;
      selectionContextResetPendingRef.current = resultEntries.length > 0;
      previousResultEntriesRef.current = [];
      previousSelectedIndexRef.current = 0;
      setPinnedSelectionEntry(null);
      return;
    }
    if (selectionContextResetPendingRef.current) {
      if (resultEntries.length === 0) {
        selectionContextResetPendingRef.current = false;
        previousResultEntriesRef.current = resultEntries;
        previousSelectedIndexRef.current = 0;
      }
      return;
    }

    const previous = previousResultEntriesRef.current;
    if (previous !== resultEntries) {
      const selectedKey = selectedEntryKeyRef.current
        ?? previous[Math.min(previousSelectedIndexRef.current, previous.length - 1)]?.key;
      if (selectedKey) {
        const nextIndex = resultEntries.findIndex((entry) => entry.key === selectedKey);
        const serverNextIndex = serverResultEntries.findIndex((entry) => entry.key === selectedKey);
        const selectedEntry = previous.find((entry) => entry.key === selectedKey)
          ?? (pinnedSelectionEntry?.key === selectedKey ? pinnedSelectionEntry : null);
        if (nextIndex >= 0 && nextIndex !== selectedResultIndex) {
          useSearchStore.getState().setSelectedResultIndex(nextIndex);
        } else if (nextIndex < 0 && !selectedEntry && selectedResultIndex !== -1) {
          useSearchStore.getState().setSelectedResultIndex(-1);
        }
        if (serverNextIndex < 0) {
          if (selectedEntry && selectedEntry !== pinnedSelectionEntry) {
            setPinnedSelectionEntry(selectedEntry);
          }
        } else if (pinnedSelectionEntry?.key !== selectedKey && pinnedSelectionEntry !== null) {
          setPinnedSelectionEntry(null);
        }
        if (nextIndex >= 0) selectedEntryKeyRef.current = selectedKey;
      } else if (resultEntries.length > 0) {
        selectedEntryKeyRef.current = resultEntries[
          Math.min(selectedResultIndex, resultEntries.length - 1)
        ]?.key;
      }
      previousResultEntriesRef.current = resultEntries;
    } else {
      if (selectedResultIndex >= 0) {
        const selectedEntry = resultEntries[selectedResultIndex];
        selectedEntryKeyRef.current = selectedEntry?.key;
        if (pinnedSelectionEntry && pinnedSelectionEntry.key !== selectedEntry?.key) {
          setPinnedSelectionEntry(null);
        }
      }
    }
    previousSelectedIndexRef.current = selectedResultIndex;
  }, [
    filters,
    pinnedSelectionEntry,
    query,
    resultEntries,
    scope,
    selectedResultIndex,
    serverResultEntries,
  ]);

  useEffect(() => {
    useSearchStore.getState().setResultCount(resultEntries.length);
    return () => useSearchStore.getState().setResultCount(0);
  }, [resultEntries.length]);

  useEffect(() => {
    if (focusRequestId > 0) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [focusRequestId]);

  useEffect(() => {
    if (resultEntries.length === 0) return;
    if (selectedResultIndex >= resultEntries.length) {
      useSearchStore.getState().setSelectedResultIndex(resultEntries.length - 1);
    }
  }, [resultEntries.length, selectedResultIndex]);

  useEffect(() => {
    if (!tablet || rows.length === 0 || resultEntries.length === 0 || selectedResultIndex < 0) return;
    const entry = resultEntries[
      Math.min(selectedResultIndex, resultEntries.length - 1)
    ];
    const rowIndex = rows.findIndex((row) => row.key === entry.key);
    if (rowIndex >= 0) {
      listRef.current?.scrollToIndex({
        index: rowIndex,
        animated: true,
        viewPosition: 0.5,
      });
    }
  }, [resultEntries, rows, selectedResultIndex, tablet]);

  useEffect(() => {
    if (activationRequestId === 0 || resultEntries.length === 0 || selectedResultIndex < 0) return;
    const selectedKey = selectedEntryKeyRef.current;
    const entry = selectedKey
      ? resultEntries.find((candidate) => candidate.key === selectedKey)
      : undefined;
    if (!entry) return;
    openEntry(entry);
    // activationRequestId가 같은 값으로 돌아가지 않으므로 한 요청당 한 번만 실행된다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activationRequestId]);

  const renderItem = useCallback(({ item }: ListRenderItemInfo<SearchRow>) => {
    if (item.kind === 'heading') {
      return (
        <Text style={styles.heading}>
          {item.title} · {item.count}
        </Text>
      );
    }
    const index = resultEntries.findIndex((entry) => entry.key === item.key);
    if (item.kind === 'session') {
      return (
        <View
          style={tablet && index === selectedResultIndex ? styles.selected : undefined}
        >
          <SessionCardById
            sessionId={item.session.agentSessionId}
            accessibilityLabelPrefix="세션 결과"
            onPress={() => openEntry(item)}
          />
          {item.searchMatch && (
            <View style={styles.sessionResultDetails}>
              {item.searchMatch.excerpt ? (
                <Text style={styles.sessionResultExcerpt} numberOfLines={2}>
                  {item.searchMatch.excerpt}
                </Text>
              ) : null}
              {item.searchMatch.folderTitle ? (
                <Text style={styles.sessionResultFolder} numberOfLines={1}>
                  폴더 · {item.searchMatch.folderTitle}
                </Text>
              ) : null}
            </View>
          )}
        </View>
      );
    }
    if (item.kind === 'projection') {
      return (
        <View style={tablet && index === selectedResultIndex ? styles.selected : undefined}>
          <AppGlassPressable
            testID="search-session-projection-result"
            accessibilityLabel={`세션 결과, ${item.match.title}`}
            contentStyle={styles.navigationRow}
            onPress={() => openEntry(item)}
          >
            <Text style={styles.navigationKind}>세션</Text>
            <Text style={styles.navigationTitle}>{item.match.title}</Text>
            {item.match.excerpt ? (
              <Text style={styles.sessionResultExcerpt} numberOfLines={2}>
                {item.match.excerpt}
              </Text>
            ) : null}
          </AppGlassPressable>
        </View>
      );
    }
    if (item.kind === 'navigation') {
      return (
        <AppGlassPressable
          testID="search-navigation-result"
          accessibilityLabel={`폴더 결과, ${item.result.title}`}
          contentStyle={styles.navigationRow}
          onPress={() => openEntry(item)}
        >
          <Text style={styles.navigationKind}>
            폴더
          </Text>
          <Text style={styles.navigationTitle}>{item.result.title}</Text>
        </AppGlassPressable>
      );
    }
    const session = sessions[item.result.sessionId];
    return (
      <SearchResultMessageRow
        sessionTitle={getSessionDisplayName(session, item.result.sessionId)}
        eventType={item.result.eventType}
        matchSource={item.result.matchSource}
        preview={item.result.preview}
        query={query}
        selected={tablet && index === selectedResultIndex}
        onPress={() => openEntry(item)}
      />
    );
  }, [
    openEntry,
    openResult,
    query,
    resultEntries,
    selectedResultIndex,
    sessions,
    styles.heading,
    styles.navigationKind,
    styles.navigationRow,
    styles.navigationTitle,
    styles.selected,
    styles.sessionResultDetails,
    styles.sessionResultExcerpt,
    styles.sessionResultFolder,
    styles.searchPartialStatus,
    tablet,
  ]);

  const hasFilter = !filtersEqualDefault(filters);
  return (
    <View style={styles.container}>
      <FlatList
        ref={listRef}
        testID="session-search-results"
        data={rows}
        keyExtractor={(item) => item.key}
        renderItem={renderItem}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentInsetAdjustmentBehavior="automatic"
        {...SESSION_FEED_VIRTUALIZATION}
        onEndReached={hasMore ? loadMore : undefined}
        onEndReachedThreshold={0.6}
        onScrollToIndexFailed={(info) => {
          listRef.current?.scrollToOffset({
            offset: Math.max(0, info.averageItemLength * info.index),
            animated: true,
          });
        }}
        contentContainerStyle={styles.content}
        ListHeaderComponent={
          <View style={styles.header}>
            {showInput ? (
              <SessionSearchField
                ref={inputRef}
                value={query}
                autoFocus={autoFocus}
                filterActive={hasFilter}
                onChangeText={useSearchStore.getState().setQuery}
                onSubmitEditing={() =>
                  useSearchStore.getState().rememberQuery(query)
                }
                onFilterPress={() => setFilterVisible(true)}
              />
            ) : (
              <View style={styles.tabletSearchActions}>
                <Text style={styles.tabletSearchLabel}>
                  {query.trim() ? `"${query.trim()}" 검색 결과` : '세션 검색'}
                </Text>
                <GlassButton
                  accessibilityLabel={hasFilter ? '검색 필터, 적용됨' : '검색 필터'}
                  onPress={() => setFilterVisible(true)}
                  style={[styles.filterAction, hasFilter && styles.filterActionActive]}
                >
                  <Ionicons
                    name="options-outline"
                    color={hasFilter ? t.colors.accent : t.colors.textMuted}
                    size={t.iconSize.standard}
                  />
                </GlassButton>
              </View>
            )}
            <SearchScopeSegment
              value={scope}
              onChange={useSearchStore.getState().setScope}
            />
            <SearchContentScopeToggles
              includeTurnSummaries={filters.includeTurnSummaries}
              includeHighlight={filters.includeHighlight}
              includeStory={filters.includeStory}
              onChange={useSearchStore.getState().setFilters}
            />
            <SearchFilterChips
              filters={filters}
              folders={folders}
              onChange={useSearchStore.getState().setFilters}
            />
            {expansionFailed ? (
              <Text accessibilityRole="alert" style={styles.searchPartialStatus}>
                추가 검색을 마치지 못했습니다. 현재 결과를 유지합니다.
              </Text>
            ) : searchStatus?.search?.status === 'partial' ? (
              <Text accessibilityRole="alert" style={styles.searchPartialStatus}>
                {searchStatus.search.stage === 'lexical'
                  ? '검색이 시간 제한에 걸려 완료되지 않았습니다. 받은 결과만 표시합니다.'
                  : '검색이 시간 제한에 걸려 일부 결과만 표시합니다.'}
              </Text>
            ) : searchStatus?.queryExpansion.status === 'partial' ? (
              <Text accessibilityRole="alert" style={styles.searchPartialStatus}>
                의미 검색을 사용할 수 없어 현재 가능한 검색 결과만 표시합니다.
              </Text>
            ) : null}
            {error && !loading && rows.length > 0 ? (
              <Text accessibilityRole="alert" style={styles.searchPartialStatus}>
                일부 검색 경로를 불러오지 못했습니다: {error}
              </Text>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          query.trim() ? (
            loading ? (
              <ActivityIndicator
                testID="search-loading"
                color={t.colors.accent}
                style={styles.loading}
              />
            ) : expansionPending ? (
              <Text accessibilityLiveRegion="polite" style={styles.searchPartialStatus}>
                의미 검색 중…
              </Text>
            ) : (
              <SearchEmpty
                icon={error ? 'alert-circle-outline' : 'search-outline'}
                title={error
                  ? '검색하지 못했습니다'
                  : searchIncomplete
                    ? '검색을 완료하지 못했습니다'
                    : '검색 결과가 없습니다'}
                detail={error ?? (searchIncomplete
                  ? '일부 검색을 끝내지 못했습니다. 다시 검색해 주세요.'
                  : '다른 검색어나 필터를 사용해보세요.')}
                onLoadMore={!error && hasMore ? loadMore : undefined}
                styles={styles}
                t={t}
              />
            )
          ) : (
            <SearchRecents
              recentQueries={recentQueries}
              recentSessionIds={recentSessionIds}
              folders={folders}
              styles={styles}
              onQuery={(value) => {
                useSearchStore.getState().setQuery(value);
                requestAnimationFrame(() => inputRef.current?.focus());
              }}
              onFolder={(folderId) => {
                useSearchStore.getState().setFilters({ folderId });
                requestAnimationFrame(() => inputRef.current?.focus());
              }}
              onOpenSession={openResult}
            />
          )
        }
        ListFooterComponent={
          rows.length > 0 && expansionPending ? (
            <Text accessibilityLiveRegion="polite" style={styles.searchPartialStatus}>
              의미 검색 중…
            </Text>
          ) : rows.length > 0 && loading ? (
            <ActivityIndicator color={t.colors.accent} style={styles.loading} />
          ) : rows.length > 0 && hasMore ? (
            <GlassButton
              accessibilityLabel="검색 결과 더 불러오기"
              onPress={loadMore}
              style={styles.more}
            >
              <Text style={styles.moreText}>결과 더 보기</Text>
            </GlassButton>
          ) : null
        }
      />
      <SearchFilterModal
        visible={filterVisible}
        tablet={tablet}
        filters={filters}
        folders={folders}
        nodeIds={nodeIds}
        backends={backends}
        onChange={useSearchStore.getState().setFilters}
        onClose={() => setFilterVisible(false)}
      />
    </View>
  );
}

function searchResultTarget(entry: ResultEntry) {
  if (entry.kind === 'session') {
    return { kind: 'session' as const, id: entry.session.agentSessionId };
  }
  if (entry.kind === 'projection') {
    return { kind: 'session' as const, id: entry.match.sessionId };
  }
  if (entry.kind === 'message') {
    return { kind: 'session' as const, id: entry.result.sessionId };
  }
  return { kind: 'folder' as const, id: entry.result.folderId };
}

function filtersEqualDefault(filters: ReturnType<typeof useSearchStore.getState>['filters']) {
  return (
    filters.folderId === null &&
    filters.nodeId === null &&
    filters.statuses.length === 0 &&
    filters.backends.length === 0 &&
    filters.period === 'all' &&
    filters.eventCategories.length === 2 &&
    filters.eventCategories.includes('messages') &&
    filters.eventCategories.includes('responses') &&
    !filters.includeTurnSummaries &&
    !filters.includeHighlight &&
    !filters.includeStory
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}
