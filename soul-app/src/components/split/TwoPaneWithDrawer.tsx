import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  StyleSheet,
  TouchableWithoutFeedback,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUIStore } from '../../store/uiStore';
import { SidebarPane } from './SidebarPane';
import { MainListPane } from './MainListPane';
import { Splitter } from './Splitter';
import { FolderWorkspaceReadOverlay } from '../planner/FolderWorkspaceReadOverlay';
import { useTokens, type DesignTokens } from '../../theme';
import { createSurfaceRoles } from '../../theme/surfaceRoles';
import { SplitPanelSurface } from './SplitPanelSurface';
import { TabletSafeAreaFrame } from './TabletSafeAreaFrame';
import { TabletSessionFeedPane } from './TabletSessionFeedPane';
import { TabletHomeComposerHost } from './TabletHomeComposerHost';
import { clampTwoPaneMiddleDrag, resolveTwoPaneMiddleWidth } from './paneWidths';
import { DUO_RAIL_END_INSET, getDuoRailTopOffset, splitDuoRailBackAction, useDuoSideBand } from '../../navigation/duoSideBand';
import { useSearchStore } from '../../store/searchStore';
import { useCardDisplay } from '../../hooks/useCardDisplay';
import { RAIL_CAPSULE_WIDTH, RailCapsule, RailCapsuleItem, RailCapsuleViewport } from '../navigation/RailCapsule';
import { TabletPersistentEntry } from '../../navigation/TabletPersistentEntry';
import { AppKeyboardAvoidingView } from '../AppKeyboardAvoidingView';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { MainListPaneHandle } from './MainListPane';
import { useActiveDuoRailOverrideEntry } from '../../navigation/phoneRailActions';

const DRAWER_WIDTH = 280;
const ANIM_MS = 240;

/**
 * 세로 태블릿용 2-pane 레이아웃.
 *
 * 메인 화면은 [Planner | Splitter | Sessions]의 2-pane 구조이고,
 * Sidebar는 평소엔 숨어 있다가 햄버거 버튼/스와이프로 슬라이드 인되는 오버레이로 표시한다.
 *
 *   평소:                              드로어 열린 상태:
 *   ┌──────────┬─┬─────────────┐      ┌──────────┐ (어두운 백드롭)
 *   │ Planner  │║│  Sessions   │      │ Sidebar  │ ← 슬라이드 인
 *   │ (햄버거) │║│             │      │          │
 *   └──────────┴─┴─────────────┘      └──────────┘
 *
 * - 항목 선택 시 드로어 자동 닫힘 (SidebarPane.onItemSelected 콜백)
 * - 백드롭 탭으로도 닫힘
 * - Animated.timing 슬라이드 (240ms)
 */
export function TwoPaneWithDrawer() {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const duo = useDuoSideBand();
  const override = useActiveDuoRailOverrideEntry();
  const mainRef = useRef<MainListPaneHandle>(null);
  const [keyboardOverlap, setKeyboardOverlap] = useState(0);
  const activeSection = useUIStore(state => state.activeSection);
  const views = useUIStore(state => state.mainPaneViews);
  const board = activeSection.kind === 'daily' || views[activeSection.folderId] === 'board';
  const showRootNavigation = !override?.actions.length || override.mode === 'prepend';
  const { backAction, mainActions } = splitDuoRailBackAction(override?.actions);
  const hasLowerActions = mainActions.length > 0 || showRootNavigation;
  const rootActionCount = showRootNavigation ? (board ? 3 : 0) + (activeSection.kind === 'project' ? 1 : 0) + 3 : 0;
  const railCompact = (override?.actions.length ?? 0) + rootActionCount >= 7 || screenHeight < 500;
  const railBottom = Math.max(keyboardOverlap, insets.bottom, t.uiSpacing.xxl);
  const lowerRailMaxHeight = backAction && keyboardOverlap > 0
    ? Math.max(0, screenHeight - railBottom - getDuoRailTopOffset(screenWidth, screenHeight)
      - RAIL_CAPSULE_WIDTH - t.uiSpacing.xs)
    : undefined;
  const cardDisplay = useCardDisplay(activeSection.kind === 'project' ? activeSection.folderId : undefined);
  const searchActive = useSearchStore(state => state.tabletActive);
  // 회전·폴드 직후에는 이전 프레임의 측정값이 남아 pane 폭이 한 번 튄다.
  // 화면 폭·안전 영역이 바뀌면 무효가 되는 key와 함께 보관한다.
  const layoutKey = `${screenWidth}:${insets.left}:${insets.right}`;
  const [measuredRow, setMeasuredRow] = useState<{ width: number; key: string } | null>(null);
  const measuredRowWidth = measuredRow?.key === layoutKey ? measuredRow.width : null;

  const paneMiddleWidth = useUIStore((s) => s.paneMiddleWidth);
  const paneMiddleWidthTwoPane = useUIStore((s) => s.paneMiddleWidthTwoPane);
  const folderOverlayVisible = useUIStore((s) => s.folderOverlayVisible);
  const cardBoardExpanded = useUIStore((s) => s.cardBoardExpanded);
  const settingsVisible = useUIStore((s) => s.settingsVisible);
  const setPaneMiddleWidthTwoPane = useUIStore((s) => s.setPaneMiddleWidthTwoPane);

  const [drawerOpen, setDrawerOpen] = useState(false);
  // -DRAWER_WIDTH(닫힘) ~ 0(열림) 사이에서 보간.
  const slideX = useRef(new Animated.Value(-DRAWER_WIDTH)).current;
  // 0(닫힘) ~ 1(열림) — 백드롭 opacity.
  const backdrop = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(slideX, {
      toValue: drawerOpen ? 0 : -DRAWER_WIDTH,
      duration: ANIM_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
    Animated.timing(backdrop, {
      toValue: drawerOpen ? 0.4 : 0,
      duration: ANIM_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [drawerOpen, slideX, backdrop]);

  const rowWidth = measuredRowWidth
    ?? screenWidth - insets.left - insets.right - 2 * t.tabletShell.outerInset;
  const resolvedMiddleWidth = resolveTwoPaneMiddleWidth({
    rowWidth,
    panelGap: t.tabletShell.panelGap,
    windowWidth: screenWidth,
    paneMiddleWidth,
    paneMiddleWidthTwoPane,
  });

  return (
    <View style={{ flex: 1 }}>
    <SafeAreaView
      style={styles.container}
      edges={['left', 'right']}
    >
      <TabletSafeAreaFrame>
        <View
          pointerEvents={folderOverlayVisible ? 'none' : 'auto'}
          style={styles.row}
          onLayout={({ nativeEvent }) => setMeasuredRow({
            width: nativeEvent.layout.width,
            key: layoutKey,
          })}
        >
          <SplitPanelSurface testID="split-panel-main" style={[styles.pane, { width: resolvedMiddleWidth }]}>
            <MainListPane
              ref={mainRef}
              onMenuPress={() => setDrawerOpen(true)}
              showSearch
              paneWidth={resolvedMiddleWidth}
            />
          </SplitPanelSurface>
          <Splitter
            initialWidth={resolvedMiddleWidth}
            onWidthChange={(width) => setPaneMiddleWidthTwoPane(clampTwoPaneMiddleDrag(width, {
              rowWidth,
              panelGap: t.tabletShell.panelGap,
            }))}
          />
          <SplitPanelSurface testID="split-panel-session" style={[styles.pane, { flex: 1 }]}>
            <TabletSessionFeedPane />
          </SplitPanelSurface>
        </View>

        <TabletHomeComposerHost />
        {/* 드로어 오버레이 — pointerEvents로 닫힘 상태에선 터치 통과 */}
        <Animated.View
          pointerEvents={drawerOpen ? 'auto' : 'none'}
          style={[
            styles.backdrop,
            {
              opacity: backdrop,
              backgroundColor: t.colors.textPrimary,
            },
          ]}
        >
          <TouchableWithoutFeedback onPress={() => setDrawerOpen(false)}>
            <View style={StyleSheet.absoluteFill} />
          </TouchableWithoutFeedback>
        </Animated.View>
        <Animated.View
          pointerEvents={drawerOpen ? 'auto' : 'none'}
          style={[
            styles.drawer,
            {
              width: DRAWER_WIDTH,
              transform: [{ translateX: slideX }],
              backgroundColor: 'transparent',
            },
          ]}
        >
          <SplitPanelSurface testID="split-panel-sidebar" style={styles.drawerPanel}>
            <SidebarPane onItemSelected={() => setDrawerOpen(false)} active={drawerOpen} />
          </SplitPanelSurface>
        </Animated.View>
        <FolderWorkspaceReadOverlay />
      </TabletSafeAreaFrame>
    </SafeAreaView>
    {duo && !cardBoardExpanded && !settingsVisible ? <AppKeyboardAvoidingView
      pointerEvents="box-none" behavior="padding" onOverlapChange={setKeyboardOverlap}
      style={StyleSheet.absoluteFill}>
      {backAction ? <View pointerEvents="box-none" style={{ position: 'absolute', top: getDuoRailTopOffset(screenWidth, screenHeight),
        right: (insets.right - 48 + DUO_RAIL_END_INSET) / 2 }}>
        <RailCapsule testID={hasLowerActions ? 'duo-rail-back-capsule' : 'duo-main-band-capsule'} compact={railCompact}>
          <RailCapsuleItem testID={`duo-rail-action-${backAction.id}`} label={backAction.label} selected={backAction.selected}
            badgeCount={backAction.badgeCount} dot={backAction.dot} disabled={backAction.disabled} onPress={backAction.onPress}>
            <Ionicons name={backAction.icon} color={backAction.selected ? t.colors.accent : t.colors.textMuted} size={t.iconSize.standard} />
          </RailCapsuleItem>
        </RailCapsule>
      </View> : null}
      {hasLowerActions ?
      <View testID="duo-main-band" pointerEvents="box-none" style={{
        position: 'absolute', right: 0, width: insets.right, alignItems: 'center',
        paddingRight: DUO_RAIL_END_INSET,
        bottom: railBottom,
      }}>
        <RailCapsuleViewport testID="duo-main-actions-scroll" maxHeight={lowerRailMaxHeight}>
        <RailCapsule testID="duo-main-band-capsule" compact={railCompact}>
          {mainActions.map(action => <RailCapsuleItem key={action.id} testID={`duo-rail-action-${action.id}`}
            label={action.label} selected={action.selected} badgeCount={action.badgeCount} dot={action.dot} disabled={action.disabled} onPress={action.onPress}>
            <Ionicons name={action.icon} color={action.selected ? t.colors.accent : t.colors.textMuted} size={t.iconSize.standard} />
          </RailCapsuleItem>)}
          {showRootNavigation ? <>
          {board ? <>
            <RailCapsuleItem testID="duo-main-create" label="드래프트 카드 추가" onPress={() => mainRef.current?.openCreate()}>
              <Ionicons name="add-outline" color={t.colors.textMuted} size={t.iconSize.standard} />
            </RailCapsuleItem>
            <RailCapsuleItem testID="duo-main-completed" label="완료·취소 숨김" selected={!cardDisplay.includeCompleted}
              onPress={() => cardDisplay.onChange(!cardDisplay.includeCompleted)}>
              <Ionicons name={cardDisplay.includeCompleted ? 'eye-outline' : 'eye-off-outline'}
                color={cardDisplay.includeCompleted ? t.colors.textMuted : t.colors.accent} size={t.iconSize.standard} />
            </RailCapsuleItem>
            <RailCapsuleItem testID="duo-main-expand" label="보드 확대" onPress={() => mainRef.current?.openExpanded()}>
              <Ionicons name="expand-outline" color={t.colors.textMuted} size={t.iconSize.standard} />
            </RailCapsuleItem>
          </> : null}
          {activeSection.kind === 'project' ? <RailCapsuleItem testID="duo-main-view" label={board ? '기존 보기' : '카드 보드'}
            onPress={() => useUIStore.getState().setMainPaneView(activeSection.folderId, board ? 'existing' : 'board')}>
            <Ionicons name={board ? 'list-outline' : 'grid-outline'} color={t.colors.textMuted} size={t.iconSize.standard} />
          </RailCapsuleItem> : null}
          <RailCapsuleItem testID="duo-main-menu" label="메뉴" onPress={() => setDrawerOpen(true)}>
            <Ionicons name="menu" color={t.colors.textMuted} size={t.iconSize.standard} />
          </RailCapsuleItem>
          <RailCapsuleItem testID="duo-main-search" label={searchActive ? '검색 닫기' : '세션 검색'}
            selected={searchActive} onPress={() => searchActive
              ? useSearchStore.getState().closeTabletSearch() : useSearchStore.getState().openTabletSearch()}>
            <Ionicons name="search-outline" color={searchActive ? t.colors.accent : t.colors.textMuted} size={t.iconSize.standard} />
          </RailCapsuleItem>
          <TabletPersistentEntry rail />
          </> : null}
        </RailCapsule>
        </RailCapsuleViewport>
      </View> : null}
    </AppKeyboardAvoidingView> : null}
    </View>
  );
}

function makeStyles(t: DesignTokens) {
  const roles = createSurfaceRoles(t);
  return StyleSheet.create({
    container: { flex: 1, ...roles.canvas.tokenStyle },
    row: {
      flex: 1,
      flexDirection: 'row',
      isolation: 'isolate',
      zIndex: 0,
    },
    pane: { height: '100%' },
    backdrop: {
      ...StyleSheet.absoluteFill,
    },
    drawer: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: 0,
      borderRadius: t.foundation.radius.panel,
      // iOS-style soft shadow.
      shadowColor: '#000',
      shadowOpacity: 0.2,
      shadowRadius: 12,
      shadowOffset: { width: 2, height: 0 },
      elevation: 8,
    },
    drawerPanel: { flex: 1 },
  });
}
