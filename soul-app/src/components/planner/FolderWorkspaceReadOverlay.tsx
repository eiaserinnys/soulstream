import { useOptionalLayoutContinuity } from '../../navigation/LayoutContinuityContext';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
  useWindowDimensions,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { createApiClient } from '../../api/client';
import { useSettingsStore } from '../../store/settingsStore';
import { getSessionDisplayName } from '../../lib/session-display-name';
import { useUIStore } from '../../store/uiStore';
import { useSessionStore } from '../../store/sessionStore';
import { useCardStore } from '../../store/cardStore';
import { createPlannerVisualRoles, useTokens, type DesignTokens } from '../../theme';
import { ChatPane, ChatPaneMinimumBottomPaddingContext } from '../split/ChatPane';
import { TabletPaneHeader } from '../split/TabletPaneHeader';
import { AppGlassCard } from '../AppGlassCard';
import { CardDetailContent } from './CardDetailSheet';
import { GlassButton } from '../GlassSurface';
import { FolderWorkspace } from './FolderWorkspace';
import { retryPlannerSessionWorkspace } from '../../lib/planner-folder-workspace';
import { coordinateFolderWorkspaceClose } from '../../lib/planner-folder-title-save';
import { createSurfaceRoles } from '../../theme/surfaceRoles';
import { useDuoSideBand } from '../../navigation/duoSideBand';
import { useRegisterDuoRailOverride, type PhoneRailAction } from '../../navigation/phoneRailActions';
import {
  FOLDER_WORKSPACE_BACKDROP_COLOR,
  getCardDetailPaneWidth,
  getFolderWorkspaceOverlayWidth,
  shouldUseSinglePanel,
} from '../../lib/folder-workspace-layout';

const ANIMATION_MS = 240;

export function FolderWorkspaceReadOverlay({ host = 'root', parentWidth }: {
  host?: 'root' | 'board';
  /** 오버레이가 놓이는 컨테이너의 폭. 생략하면 화면 폭을 쓴다. */
  parentWidth?: number;
}) {
  const expanded = useUIStore((state) => state.cardBoardExpanded);
  return expanded === (host === 'board')
    ? <FolderWorkspaceOverlayContent parentWidth={parentWidth} />
    : null;
}

export function CardDetailPane({ api, cardId, detailWidth, hideRightBorder = false, active = true, onClose, onOpenSession }: {
  api: ReturnType<typeof createApiClient> | null;
  cardId: string;
  detailWidth?: number;
  hideRightBorder?: boolean;
  active?: boolean;
  onClose(): void;
  onOpenSession?(id: string): void;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  return <View testID="task-workspace-task-pane" style={[styles.folderPane, detailWidth === undefined ? { flex: 1, borderRightWidth: 0 } : { width: detailWidth }, hideRightBorder ? { borderRightWidth: 0 } : null]}>
    <CardDetailContent key={cardId} api={api} cardId={cardId} inline visible={active} onClose={onClose} onOpenSession={onOpenSession} />
  </View>;
}

export function CardConversationPane({ active, sessionId, onClose, hideChat = false, ownsSessionConnection = true, chatHeaderLeading, back }: {
  active: boolean;
  sessionId?: string | null;
  onClose?: () => void;
  hideChat?: boolean;
  ownsSessionConnection?: boolean;
  chatHeaderLeading?: React.ReactNode;
  back?: React.ReactNode;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  return <View testID="task-workspace-chat-pane" style={styles.chatPane}>
    {hideChat ? null : <ChatPane active={active} sessionId={sessionId} onClose={onClose}
      ownsSessionConnection={ownsSessionConnection} headerLeading={back ?? chatHeaderLeading} />}
  </View>;
}

/** 카드/폴더 상세 열. 2열에서는 폭을 받고, 단일 열에서는 남는 폭을 다 쓴다. */
export function FolderWorkspaceDetailPane({ api, cardId, pageId, sessionId, active, width, hideRightBorder = false, onClose, onOpenSession, onOpenFolder }: {
  api: ReturnType<typeof createApiClient> | null;
  cardId: string | null;
  pageId: string | null;
  sessionId: string | null;
  active: boolean;
  width?: number;
  hideRightBorder?: boolean;
  onClose(): void;
  onOpenSession?(id: string): void;
  onOpenFolder?(folderId: string, projectPageId: string): void;
}) {
  const t = useTokens();
  const duo = useDuoSideBand();
  const styles = useMemo(() => makeStyles(t), [t]);
  const resolution = useUIStore((state) => state.sessionFolderResolution);
  const focusEventId = useUIStore((state) => state.focusEventId);
  const storyOpenRequestId = useUIStore((state) => state.storyOpenRequestId);
  const session = useSessionStore((state) => (
    sessionId ? state.sessions[sessionId] : undefined
  ));

  if (cardId) {
    return <CardDetailPane api={api} cardId={cardId} detailWidth={width} hideRightBorder={hideRightBorder} active={active}
      onClose={onClose} onOpenSession={onOpenSession} />;
  }

  return (
    <View testID="task-workspace-task-pane" style={[styles.folderPane, width === undefined ? { flex: 1, borderRightWidth: 0 } : { width }, hideRightBorder ? { borderRightWidth: 0 } : null]}>
      {pageId ? (
        <FolderWorkspace
          api={api}
          folderPageId={pageId}
          active={active}
          onOpenSession={onOpenSession}
          onClose={onClose}
          onOpenFolder={onOpenFolder}
        />
      ) : (
        <>
          <TabletPaneHeader style={styles.headerRow}>
            <Text style={styles.title} numberOfLines={3}>
              {sessionId
                ? getSessionDisplayName(session, sessionId)
                : '세션을 선택하세요'}
            </Text>
            {!duo ? <TouchableOpacity
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="세션 패널 닫기"
              style={styles.closeButton}
            >
              <Ionicons name="close" size={t.iconSize.navigation} color={t.colors.textMuted} />
            </TouchableOpacity> : null}
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
  );
}

/**
 * 좁은 오버레이용 단일 열. 상세를 먼저 보여 주고 세션을 열면 대화로 넘어간다.
 * 헤더의 뒤로 버튼으로 상세에 돌아오며, 카드/폴더가 바뀌면 상세로 리셋한다.
 */
export function FolderWorkspaceSinglePanel({ api, cardId, pageId, sessionId, active, initialStep = !cardId && !pageId && sessionId ? 'chat' : 'detail', overlayWidth, onClose, onOpenSession, onOpenFolder }: {
  api: ReturnType<typeof createApiClient> | null;
  cardId: string | null;
  pageId: string | null;
  sessionId: string | null;
  active: boolean;
  initialStep?: 'detail' | 'chat';
  overlayWidth?: number;
  onClose(): void;
  onOpenSession?(id: string): void;
  onOpenFolder?(folderId: string, projectPageId: string): void;
}) {
  const t = useTokens();
  const duo = useDuoSideBand();
  const styles = useMemo(() => makeStyles(t), [t]);
  const resolution = useUIStore((state) => state.sessionFolderResolution);
  const continuity = useOptionalLayoutContinuity();
  const memoryKey = JSON.stringify(['folder-overlay', pageId ?? cardId ?? sessionId]);
  const [step, setStep] = useState<'detail' | 'chat'>(() => initialStep === 'chat' ? 'chat' : (continuity?.getViewState<'detail' | 'chat'>(memoryKey) ?? 'detail'));
  useEffect(() => { continuity?.setViewState(memoryKey, step); }, [continuity, memoryKey, step]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(sessionId);
  const stepKey = cardId || pageId
    ? `${cardId ?? ''}:${pageId ?? ''}:${initialStep}`
    : `session:${sessionId ?? ''}:${initialStep}`;
  const lastStepKey = useRef(stepKey);
  useEffect(() => {
    setSelectedSessionId(sessionId);
    if (lastStepKey.current !== stepKey) {
      lastStepKey.current = stepKey;
      const nextStep = initialStep === 'chat' ? 'chat' : (continuity?.getViewState<'detail' | 'chat'>(memoryKey) ?? 'detail');
      continuity?.setViewState(memoryKey, nextStep);
      setStep(nextStep);
    }
  }, [continuity, initialStep, memoryKey, sessionId, stepKey]);
  const openSession = (id: string) => {
    continuity?.setViewState(memoryKey, 'chat');
    setSelectedSessionId(id);
    onOpenSession?.(id);
    setStep('chat');
  };
  const canReturnToDetail = Boolean(cardId || pageId);
  const returnToDetail = () => {
    setStep('detail');
    continuity?.setViewState(memoryKey, 'detail');
    useUIStore.setState({ overlaySessionExplicit: false, initialCardSessionId: null });
  };
  const chatActions: PhoneRailAction[] = canReturnToDetail
    ? [{ id: 'back', label: '상세로 돌아가기', icon: 'chevron-back', onPress: returnToDetail }]
    : [{ id: 'close', label: '챗 닫기', icon: 'close', onPress: onClose }];
  useRegisterDuoRailOverride('folder-chat', duo && active && (step === 'chat' || (!cardId && !pageId && !!sessionId)), chatActions);
  const backButton = (
    <GlassButton
      testID="folder-workspace-step-back"
      iconOnly
      size="compact"
      borderRadius={t.foundation.radius.round}
      accessibilityLabel="상세로 돌아가기"
      onPress={returnToDetail}
    >
      <Ionicons
        name="chevron-back"
        size={t.foundation.typography.body.fontSize}
        color={t.colors.textPrimary}
      />
    </GlassButton>
  );
  // 폴더·카드에 연결되지 않은 단독 세션은 상세 안내 화면 없이 대화를 바로 보여 준다.
  const unlinkedSession = !resolution || resolution.status === 'unlinked';
  if (!cardId && !pageId && sessionId && unlinkedSession) {
    return (
      <View testID="folder-workspace-single-panel" style={styles.singlePanel}>
        <CardConversationPane active={active} sessionId={sessionId} onClose={onClose} />
      </View>
    );
  }
  return (
    <View testID="folder-workspace-single-panel" style={styles.singlePanel}>
      {canReturnToDetail ? <View style={{ flex: 1, minHeight: 0, display: step === 'detail' ? 'flex' : 'none' }}>
        <FolderWorkspaceDetailPane
          api={api}
          cardId={cardId}
          pageId={pageId}
          sessionId={sessionId}
          active={active && step === 'detail'}
          hideRightBorder
          onClose={onClose}
          onOpenSession={openSession}
          onOpenFolder={onOpenFolder}
        />
      </View> : step === 'detail' ? <FolderWorkspaceDetailPane
        api={api}
        cardId={cardId}
        pageId={pageId}
        sessionId={sessionId}
        active={active}
        hideRightBorder
        onClose={onClose}
        onOpenSession={openSession}
        onOpenFolder={onOpenFolder}
      /> : null}
      {step === 'chat' ? <CardConversationPane
        active={active}
        sessionId={selectedSessionId}
        onClose={onClose}
        back={canReturnToDetail ? backButton : undefined}
      /> : null}
    </View>
  );
}

export function CardDetailChatPanes({ api, cardId, active, detailWidth, onClose, onOpenSession, sessionId, onCloseChat, hideChat = false, ownsSessionConnection = true }: {
  api: ReturnType<typeof createApiClient> | null;
  cardId: string;
  active: boolean;
  detailWidth?: number;
  onClose(): void;
  onOpenSession?(id: string): void;
  sessionId?: string | null;
  onCloseChat?: () => void;
  hideChat?: boolean;
  ownsSessionConnection?: boolean;
}) {
  return <>
    <CardDetailPane api={api} cardId={cardId} detailWidth={detailWidth} active={active} onClose={onClose} onOpenSession={onOpenSession} />
    <CardConversationPane active={active} sessionId={sessionId} onClose={onCloseChat} hideChat={hideChat} ownsSessionConnection={ownsSessionConnection} />
  </>;
}

export function CardPanelOverlayFrame({ visible, width, onClose, onHidden, testID = 'task-workspace', direction = 'row', chatPaneMinimumBottomPadding, children }: {
  visible: boolean;
  width: number;
  onClose(): void;
  onHidden?: () => void;
  testID?: string;
  direction?: 'row' | 'column';
  chatPaneMinimumBottomPadding?: number;
  children: React.ReactNode;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(progress, {
      toValue: visible ? 1 : 0,
      duration: ANIMATION_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: Platform.OS !== 'web',
    }).start(({ finished }) => {
      if (finished && !visible) onHidden?.();
    });
  }, [onHidden, progress, visible]);

  const translateX = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [width, 0],
  });
  return <View pointerEvents={visible ? 'auto' : 'none'} style={styles.overlayLayer} testID={`${testID}-overlay`}>
    <Animated.View style={[styles.backdrop, { opacity: progress }]}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View testID={`${testID}-backdrop-close`} style={StyleSheet.absoluteFill} />
      </TouchableWithoutFeedback>
    </Animated.View>
    <Animated.View testID={`${testID}-sheet`} style={[styles.sheet, { width, transform: [{ translateX }] }]}>
      <AppGlassCard role="glassSoft" testID={`${testID}-sheet-surface`}
        style={[styles.sheetSurface, direction === 'column' ? styles.sheetSurfaceColumn : null]}>
        <ChatPaneMinimumBottomPaddingContext.Provider value={chatPaneMinimumBottomPadding}>
          {children}
        </ChatPaneMinimumBottomPaddingContext.Provider>
      </AppGlassCard>
    </Animated.View>
  </View>;
}

function FolderWorkspaceOverlayContent({ parentWidth }: { parentWidth?: number }) {
  const t = useTokens();
  const duo = useDuoSideBand();
  const { width: screenWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const visible = useUIStore((state) => state.folderOverlayVisible);
  const cardId = useUIStore((state) => state.selectedCardId);
  const initialCardSessionId = useUIStore((state) => state.initialCardSessionId);
  const cardSessionSelectionHandled = useUIStore((state) => state.cardSessionSelectionHandled);
  const detail = useCardStore((state) => cardId ? state.details[cardId] : undefined);
  const pageId = useUIStore((state) => state.selectedFolderPageId);
  const sessionId = useUIStore((state) => state.activeSessionId);
  const overlaySessionExplicit = useUIStore((state) => state.overlaySessionExplicit);
  const initialStep: 'detail' | 'chat' =
    initialCardSessionId || (overlaySessionExplicit && Boolean(sessionId)) || (!cardId && !pageId && Boolean(sessionId))
      ? 'chat'
      : 'detail';
  const close = useUIStore((state) => state.closeFolderOverlay);
  const setActiveSessionId = useUIStore((state) => state.setActiveSessionId);
  const initializeCardSessionSelection = useUIStore((state) => state.initializeCardSessionSelection);
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const api = useMemo(() => serverUrl ? createApiClient(serverUrl) : null, [serverUrl]);
  // 레일 모드에서는 화면 폭에서 좌우 안전 여백을 뺀 폭이 실제 시트 가용 폭이다.
  const safeParentWidth = Math.max(0, parentWidth ?? (screenWidth - insets.left - insets.right));
  const overlayWidth = getFolderWorkspaceOverlayWidth(safeParentWidth);
  const singlePanel = shouldUseSinglePanel(overlayWidth);
  useRegisterDuoRailOverride('unlinked-chat', duo && visible && !singlePanel && !cardId && !pageId && !!sessionId,
    [{ id: 'close', label: '챗 닫기', icon: 'close', onPress: close }]);
  const sheetWidth = singlePanel
    ? overlayWidth
    : overlayWidth + (cardId ? StyleSheet.hairlineWidth * 2 : 0);
  const folderPaneWidth = singlePanel
    ? undefined
    : cardId
      ? getCardDetailPaneWidth(overlayWidth)
      : resolveFolderPaneWidth(overlayWidth, t.tabletShell.folderPane);
  const requestClose = () => coordinateFolderWorkspaceClose(pageId, close);
  const openFolder = (folderId: string, projectPageId: string) => {
    useUIStore.getState().setActiveSection({ kind: 'project', folderId, projectPageId });
    useUIStore.getState().openFolderOverlay(projectPageId);
  };

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

  return (
    <CardPanelOverlayFrame
      visible={visible}
      width={sheetWidth}
      onClose={requestClose}
      direction={singlePanel ? 'column' : 'row'}
    >
      {singlePanel ? (
        <FolderWorkspaceSinglePanel
          api={api}
          cardId={cardId}
          pageId={pageId}
          sessionId={sessionId}
          active={visible}
          initialStep={initialStep}
          overlayWidth={overlayWidth}
          onClose={close}
          onOpenSession={setActiveSessionId}
          onOpenFolder={openFolder}
        />
      ) : (
        <>
          <FolderWorkspaceDetailPane
            api={api}
            cardId={cardId}
            pageId={pageId}
            sessionId={sessionId}
            active={visible}
            width={folderPaneWidth}
            onClose={close}
            onOpenSession={setActiveSessionId}
            onOpenFolder={openFolder}
          />
          <CardConversationPane active={visible} />
        </>
      )}
    </CardPanelOverlayFrame>
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
      backgroundColor: FOLDER_WORKSPACE_BACKDROP_COLOR,
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
    sheetSurfaceColumn: { flexDirection: 'column' },
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
    singlePanel: { flex: 1, minWidth: 0 },
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
