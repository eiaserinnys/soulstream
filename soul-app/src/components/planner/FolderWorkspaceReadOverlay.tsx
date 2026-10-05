import React, { useEffect, useMemo, useRef } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
  useWindowDimensions,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { createApiClient } from '../../api/client';
import { useSettingsStore } from '../../store/settingsStore';
import { getSessionDisplayName } from '../../lib/session-display-name';
import { useUIStore } from '../../store/uiStore';
import { useSessionStore } from '../../store/sessionStore';
import { useCardStore } from '../../store/cardStore';
import { createPlannerVisualRoles, useTokens, type DesignTokens } from '../../theme';
import { ChatPane } from '../split/ChatPane';
import { TabletPaneHeader } from '../split/TabletPaneHeader';
import { AppGlassCard } from '../AppGlassCard';
import { CardDetailContent } from './CardDetailSheet';
import { FolderWorkspace } from './FolderWorkspace';
import { retryPlannerSessionWorkspace } from '../../lib/planner-folder-workspace';
import { coordinateFolderWorkspaceClose } from '../../lib/planner-folder-title-save';
import { createSurfaceRoles } from '../../theme/surfaceRoles';

const ANIMATION_MS = 240;

export function FolderWorkspaceReadOverlay({ host = 'root' }: { host?: 'root' | 'board' }) {
  const expanded = useUIStore((state) => state.cardBoardExpanded);
  return expanded === (host === 'board') ? <FolderWorkspaceOverlayContent /> : null;
}

function FolderWorkspaceOverlayContent() {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const { width: screenWidth } = useWindowDimensions();
  const visible = useUIStore((state) => state.folderOverlayVisible);
  const cardId = useUIStore((state) => state.selectedCardId);
  const initialCardSessionId = useUIStore((state) => state.initialCardSessionId);
  const cardSessionSelectionHandled = useUIStore((state) => state.cardSessionSelectionHandled);
  const detail = useCardStore((state) => cardId ? state.details[cardId] : undefined);
  const pageId = useUIStore((state) => state.selectedFolderPageId);
  const sessionId = useUIStore((state) => state.activeSessionId);
  const resolution = useUIStore((state) => state.sessionFolderResolution);
  const focusEventId = useUIStore((state) => state.focusEventId);
  const storyOpenRequestId = useUIStore((state) => state.storyOpenRequestId);
  const close = useUIStore((state) => state.closeFolderOverlay);
  const setActiveSessionId = useUIStore((state) => state.setActiveSessionId);
  const initializeCardSessionSelection = useUIStore((state) => state.initializeCardSessionSelection);
  const session = useSessionStore((state) => (
    sessionId ? state.sessions[sessionId] : undefined
  ));
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const api = useMemo(() => serverUrl ? createApiClient(serverUrl) : null, [serverUrl]);
  const progress = useRef(new Animated.Value(0)).current;
  const overlayWidth = Math.min(Math.floor(screenWidth * 0.9), 920);
  const folderPaneWidth = resolveFolderPaneWidth(
    overlayWidth,
    t.tabletShell.folderPane,
  );
  const requestClose = () => coordinateFolderWorkspaceClose(pageId, close);

  // Feed-selected sessions win once; normal card opens keep assignee-first behavior.
  useEffect(() => {
    if (!visible || !cardId || !detail || cardSessionSelectionHandled) return;
    const assigneeSessionId = detail.card.assigneeKind === 'session'
      ? detail.card.assigneeSessionId
      : null;
    initializeCardSessionSelection(cardId, initialCardSessionId || assigneeSessionId || null);
  }, [
    visible,
    cardId,
    detail,
    initialCardSessionId,
    cardSessionSelectionHandled,
    initializeCardSessionSelection,
  ]);

  useEffect(() => {
    Animated.timing(progress, {
      toValue: visible ? 1 : 0,
      duration: ANIMATION_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [progress, visible]);

  const translateX = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [overlayWidth, 0],
  });

  return (
    <View
      pointerEvents={visible ? 'auto' : 'none'}
      style={styles.overlayLayer}
      testID="task-workspace-overlay"
    >
      <Animated.View style={[styles.backdrop, { opacity: progress }]}>
        <TouchableWithoutFeedback onPress={requestClose}>
          <View testID="task-workspace-backdrop-close" style={StyleSheet.absoluteFill} />
        </TouchableWithoutFeedback>
      </Animated.View>
      <Animated.View
        testID="task-workspace-sheet"
        style={[
          styles.sheet,
          {
            width: overlayWidth,
            transform: [{ translateX }],
          },
        ]}
      >
        <AppGlassCard
          role="glassSoft"
          testID="task-workspace-sheet-surface"
          style={styles.sheetSurface}
        >
          <View
            testID="task-workspace-task-pane"
            style={[styles.folderPane, { width: folderPaneWidth }]}
          >
          {cardId ? <CardDetailContent key={cardId} api={api} cardId={cardId} inline onClose={close} onOpenSession={setActiveSessionId} /> : pageId ? (
            <FolderWorkspace
              api={api}
              folderPageId={pageId}
              active={visible}
              onOpenSession={setActiveSessionId}
              onClose={close}
              onOpenFolder={(folderId, projectPageId) => {
                useUIStore.getState().setActiveSection({ kind: 'project', folderId, projectPageId });
                useUIStore.getState().openFolderOverlay(projectPageId);
              }}
            />
          ) : (
            <>
              <TabletPaneHeader style={styles.headerRow}>
                <Text style={styles.title} numberOfLines={3}>
                  {sessionId
                    ? getSessionDisplayName(session, sessionId)
                    : '세션을 선택하세요'}
                </Text>
                <TouchableOpacity
                  onPress={close}
                  accessibilityRole="button"
                  accessibilityLabel="세션 패널 닫기"
                  style={styles.closeButton}
                >
                  <Ionicons name="close" size={t.iconSize.navigation} color={t.colors.textMuted} />
                </TouchableOpacity>
              </TabletPaneHeader>
              <ScrollView contentContainerStyle={styles.folderContent}>
                {resolution?.status === 'loading' ? (
                  <View testID="session-task-loading" style={styles.stateRow}>
                    <ActivityIndicator color={t.colors.accent} />
                    <Text style={styles.sessionOnlyHint}>폴더 연결을 확인하는 중입니다.</Text>
                  </View>
                ) : resolution?.status === 'error' ? (
                  <View testID="session-task-error" style={styles.errorState}>
                    <Text style={styles.sessionOnlyHint}>
                      {resolution.message ?? '폴더 연결을 확인하지 못했습니다.'}
                    </Text>
                    {sessionId && resolution.retryable ? (
                      <TouchableOpacity
                        testID="session-task-retry"
                        accessibilityRole="button"
                        accessibilityLabel="폴더 연결 다시 시도"
                        style={styles.retryButton}
                        onPress={() => retryPlannerSessionWorkspace(
                          sessionId,
                          focusEventId,
                          storyOpenRequestId,
                        )}
                      >
                        <Text style={styles.retryText}>다시 시도</Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                ) : (
                  <Text testID="session-task-unlinked" style={styles.sessionOnlyHint}>
                    이 세션은 폴더에 연결되어 있지 않아 세션 채팅만 표시합니다.
                  </Text>
                )}
              </ScrollView>
            </>
          )}
          </View>
          <View style={styles.chatPane}>
            <ChatPane active={visible} />
          </View>
        </AppGlassCard>
      </Animated.View>
    </View>
  );
}

function makeStyles(t: DesignTokens) {
  const roles = createSurfaceRoles(t);
  const planner = createPlannerVisualRoles(t);
  return StyleSheet.create({
    overlayLayer: {
      ...StyleSheet.absoluteFill,
      zIndex: 1,
      overflow: 'hidden',
    },
    backdrop: {
      ...StyleSheet.absoluteFill,
      backgroundColor: 'rgba(0, 0, 0, 0.38)',
    },
    sheet: {
      position: 'absolute',
      right: 0,
      top: 0,
      bottom: 0,
      borderRadius: t.foundation.radius.panel,
      shadowColor: '#000',
      shadowOpacity: 0.28,
      shadowRadius: 18,
      shadowOffset: { width: -4, height: 0 },
      elevation: 16,
    },
    sheetSurface: {
      flex: 1,
      flexDirection: 'row',
    },
    folderPane: {
      borderRightWidth: StyleSheet.hairlineWidth,
      borderRightColor: t.colors.borderSubtle,
      backgroundColor: roles.glassCard.tokenStyle.backgroundColor,
    },
    headerRow: {
      marginBottom: t.spacing.sm,
    },
    title: {
      flex: 1,
      color: t.colors.textPrimary,
      ...planner.typography.navigation,
    },
    closeButton: {
      width: planner.actionColumn,
      height: planner.actionColumn,
      alignItems: 'center',
      justifyContent: 'center',
    },
    folderContent: { padding: planner.pageInset, gap: t.spacing.lg },
    sessionOnlyHint: { color: t.colors.textTertiary, ...planner.typography.meta },
    stateRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
    errorState: { gap: t.spacing.sm, alignItems: 'flex-start' },
    retryButton: {
      minWidth: planner.actionColumn,
      minHeight: planner.actionColumn,
      justifyContent: 'center',
    },
    retryText: { color: t.colors.accent, ...planner.typography.label },
    chatPane: { flex: 1, minWidth: 0 },
  });
}

export function resolveFolderPaneWidth(
  overlayWidth: number,
  metrics: DesignTokens['tabletShell']['folderPane'],
): number {
  return Math.max(
    metrics.minWidth,
    Math.min(metrics.maxWidth, Math.round(overlayWidth * metrics.fraction)),
  );
}
