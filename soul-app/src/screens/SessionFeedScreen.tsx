import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type ListRenderItemInfo,
  type ViewToken,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { createApiClient } from '../api/client';
import type { Session } from '../api/types';
import { SessionCardById } from '../components/SessionCardById';
import { classifySessionFeed } from '../lib/session-feed-groups';
import { useSessionStore } from '../store/sessionStore';
import { useNodeConnectivityStore } from '../store/nodeConnectivityStore';
import { useSettingsStore } from '../store/settingsStore';
import { createSessionVisualRoles, useTokens, type DesignTokens } from '../theme';
import { usePlannerContextMenus } from '../hooks/usePlannerContextMenus';
import { SessionSuccessionHost } from '../components/planner/SessionSuccessionHost';
import { HomeComposerSpacer } from '../components/planner/HomeComposerSpacer';
import { createSurfaceRoles } from '../theme/surfaceRoles';
import { SESSION_FEED_VIRTUALIZATION } from '../lib/session-feed-virtualization';
import { recordFeedCommit } from '../lib/session-diagnostics-api';
import { useFeedPagination } from '../hooks/useFeedPagination';
import { makeStyles as makeChatStyles } from '../components/chat/ChatBody.styles';

type FeedRow =
  | { kind: 'heading'; key: string; title: string; count: number; hasMore?: boolean }
  | { kind: 'session'; key: string; sessionId: string }
  | { kind: 'empty'; key: string };

export function SessionFeedScreen({
  active = true,
  onOpenSession,
  topInsetPadding = false,
  reserveBottomSearchBarSpace = false,
  reserveHomeComposerSpace = false,
}: {
  active?: boolean;
  onOpenSession?: (sessionId: string) => void;
  topInsetPadding?: boolean;
  reserveBottomSearchBarSpace?: boolean;
  reserveHomeComposerSpace?: boolean;
}) {
  const renderStartedAtMs = monotonicRenderTime();
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const insets = useSafeAreaInsets();
  const feedSessionIds = useSessionStore((state) => state.feedSessionIds);
  const catalogLoadState = useSessionStore((state) => state.catalogLoadState);
  const retryCatalog = useSessionStore((state) => state.retryCatalog);
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const api = useMemo(() => serverUrl ? createApiClient(serverUrl) : null, [serverUrl]);
  const { feedPage, loadMore, retryFeedPage } = useFeedPagination(api);
  const chatStyles = useMemo(() => makeChatStyles(t), [t]);
  const menus = usePlannerContextMenus(api);
  const nodesReady = useNodeConnectivityStore((state) => state.ready);
  const connectedNodeIds = useNodeConnectivityStore((state) => state.connectedNodeIds);
  const onOpenSessionRef = useRef(onOpenSession);
  const openSessionMenuRef = useRef(menus.openSessionMenu);
  onOpenSessionRef.current = onOpenSession;
  openSessionMenuRef.current = menus.openSessionMenu;

  useEffect(() => {
    // This is render-to-effect latency, not a profiler measurement of JS render CPU.
    recordFeedCommit(Math.max(0, monotonicRenderTime() - renderStartedAtMs));
  });

  const groups = useMemo(
    () => {
      const sessions = useSessionStore.getState().sessions;
      return classifySessionFeed(
        feedSessionIds.flatMap((sessionId) => {
          const session = sessions[sessionId];
          return session ? [session] : [];
        }),
        {
          ready: nodesReady,
          connectedNodeIds,
        },
      );
    },
    [connectedNodeIds, feedSessionIds, nodesReady],
  );
  const rows = useMemo(() => {
    if (catalogLoadState !== 'ready') return [];
    return [
      ...groupRows('attention', '응답 필요', groups.attention),
      ...groupRows('running', '실행 중', groups.running),
      ...groupRows('review', '검수 대기', groups.review, feedPage.hasMore),
    ];
  }, [catalogLoadState, feedPage.hasMore, groups]);
  const handleOpenSession = useCallback((sessionId: string) => {
    onOpenSessionRef.current?.(sessionId);
  }, []);
  const handleLongPress = useCallback((sessionId: string) => {
    openSessionMenuRef.current({ sessionId });
  }, []);
  const [visibleSessionIds, setVisibleSessionIds] = useState<ReadonlySet<string>>(() => new Set());
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 1 }).current;
  const onViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: ViewToken<FeedRow>[] }) => {
    const next = new Set(viewableItems.flatMap(({ item, isViewable }) =>
      isViewable && item.kind === 'session' ? [item.sessionId] : []));
    setVisibleSessionIds(previous => previous.size === next.size && [...next].every(id => previous.has(id))
      ? previous : next);
  }, []);
  const renderItem = useCallback(({ item }: ListRenderItemInfo<FeedRow>) => {
    if (item.kind === 'heading') {
      return <Text style={styles.heading}>{item.title} · {item.count}{item.hasMore ? '+' : ''}</Text>;
    }
    if (item.kind === 'empty') {
      return <Text style={styles.empty}>해당 세션이 없습니다.</Text>;
    }
    return (
      <SessionCardById
        sessionId={item.sessionId}
        animationActive={active && visibleSessionIds.has(item.sessionId)}
        onPress={handleOpenSession}
        onLongPress={handleLongPress}
      />
    );
  }, [active, visibleSessionIds, handleLongPress, handleOpenSession, styles.empty, styles.heading]);
  const renderEmpty = useCallback(() => {
    if (catalogLoadState === 'loading') {
      return (
        <View style={styles.loadState}>
          <ActivityIndicator color={t.colors.accent} />
          <Text style={styles.loadStateText}>세션을 불러오는 중입니다.</Text>
        </View>
      );
    }
    if (catalogLoadState === 'error') {
      return (
        <View style={styles.loadState}>
          <Text accessibilityRole="alert" style={styles.errorText}>
            세션 목록을 불러오지 못했습니다.
          </Text>
          <TouchableOpacity
            testID="session-feed-retry"
            accessibilityRole="button"
            accessibilityLabel="세션 목록 다시 시도"
            style={styles.retryButton}
            onPress={retryCatalog}
          >
            <Text style={styles.retryButtonText}>다시 시도</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return null;
  }, [catalogLoadState, retryCatalog, styles, t.colors.accent]);
  const renderFooter = useCallback(() => (
    <>
      {feedPage.status === 'loading' ? (
        <View style={chatStyles.footerLoader}>
          <ActivityIndicator color={t.colors.accent} />
        </View>
      ) : feedPage.status === 'error' ? (
        <View style={styles.loadState}>
          <Text accessibilityRole="alert" style={styles.errorText}>
            세션을 더 불러오지 못했습니다.
          </Text>
          <TouchableOpacity
            testID="session-feed-page-retry"
            accessibilityRole="button"
            accessibilityLabel="세션 더 불러오기 다시 시도"
            style={styles.retryButton}
            onPress={() => { void retryFeedPage(); }}
          >
            <Text style={styles.retryButtonText}>다시 시도</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      <HomeComposerSpacer enabled={reserveHomeComposerSpace} precedingGap={0} testID="feed-home-composer-spacer" />
    </>
  ), [chatStyles.footerLoader, feedPage.status, reserveHomeComposerSpace, retryFeedPage, styles, t.colors.accent]);

  return (
    <View style={styles.container}>
      <FlatList
        testID="phone-feed-body"
        style={styles.container}
        data={rows}
        keyExtractor={feedRowKey}
        contentInsetAdjustmentBehavior="automatic"
        {...SESSION_FEED_VIRTUALIZATION}
        contentContainerStyle={[
          styles.content,
          topInsetPadding && { paddingTop: insets.top + t.spacing.md },
          { paddingBottom: reserveBottomSearchBarSpace
            ? insets.bottom + t.hitTarget.min + t.spacing.md : t.spacing.md },
        ]}
        renderItem={renderItem}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
        ListEmptyComponent={renderEmpty}
        ListFooterComponent={renderFooter}
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
      />
      <SessionSuccessionHost
        api={api}
        request={menus.sessionSuccession}
        onClose={menus.closeSessionSuccession}
        onCreated={(sessionId) => onOpenSession?.(sessionId)}
      />
    </View>
  );
}

function monotonicRenderTime(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function groupRows(key: string, title: string, sessions: readonly Session[], hasMore = false): FeedRow[] {
  return [
    { kind: 'heading', key: `${key}:heading`, title, count: sessions.length, ...(hasMore ? { hasMore: true } : {}) },
    ...(sessions.length > 0
      ? sessions.map((session) => ({
          kind: 'session' as const,
          key: `${key}:${session.agentSessionId}`,
          sessionId: session.agentSessionId,
        }))
      : [{ kind: 'empty' as const, key: `${key}:empty` }]),
  ];
}

function feedRowKey(item: FeedRow): string {
  return item.key;
}

function makeStyles(t: DesignTokens) {
  const roles = createSurfaceRoles(t);
  const sessionRoles = createSessionVisualRoles(t);
  return StyleSheet.create({
    container: { flex: 1, ...roles.canvas.tokenStyle },
    content: {
      paddingHorizontal: sessionRoles.feed.pageInset,
      paddingVertical: t.spacing.md,
    },
    heading: {
      color: t.colors.textPrimary,
      ...t.foundation.typography.section,
      paddingTop: t.spacing.lg,
      paddingBottom: t.spacing.sm,
    },
    empty: {
      color: t.colors.textPlaceholder,
      fontSize: t.fontSize.body,
      paddingBottom: t.spacing.sm,
    },
    loadState: {
      alignItems: 'center',
      gap: t.spacing.sm,
      paddingVertical: t.spacing.xxl,
    },
    loadStateText: {
      color: t.colors.textSecondary,
      fontSize: t.fontSize.body,
    },
    errorText: {
      color: t.colors.errorText,
      fontSize: t.fontSize.body,
    },
    retryButton: {
      alignItems: 'center',
      justifyContent: 'center',
      minWidth: t.hitTarget.min,
      minHeight: t.hitTarget.min,
      paddingHorizontal: t.spacing.md,
    },
    retryButtonText: {
      color: t.colors.accent,
      fontSize: t.fontSize.body,
      fontWeight: '600',
    },
  });
}
