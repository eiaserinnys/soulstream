import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  StyleSheet,
  TouchableWithoutFeedback,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
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
  const { width: screenWidth } = useWindowDimensions();

  const paneMiddleWidth = useUIStore((s) => s.paneMiddleWidth);
  const folderOverlayVisible = useUIStore((s) => s.folderOverlayVisible);
  const setPaneMiddleWidth = useUIStore((s) => s.setPaneMiddleWidth);

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

  // 세로 모드에서 중앙 패널이 너무 넓으면 세션 패널이 좁아진다 — 화면 폭의 절반으로 추가 clamp.
  const clampedMiddle = Math.min(paneMiddleWidth, Math.floor(screenWidth * 0.5));

  return (
    <SafeAreaView
      style={styles.container}
      edges={['left', 'right']}
    >
      <TabletSafeAreaFrame>
        <View
          pointerEvents={folderOverlayVisible ? 'none' : 'auto'}
          style={styles.row}
        >
          <SplitPanelSurface testID="split-panel-main" style={[styles.pane, { width: clampedMiddle }]}>
            <MainListPane
              onMenuPress={() => setDrawerOpen(true)}
              showSearch
            />
          </SplitPanelSurface>
          <Splitter
            initialWidth={clampedMiddle}
            onWidthChange={setPaneMiddleWidth}
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
