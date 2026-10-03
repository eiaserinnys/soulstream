import React, { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
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

/**
 * 가로 태블릿용 3-pane 레이아웃.
 *
 *   ┌──────────┬─┬───────────┬─┬────────────────┐
 *   │ Sidebar  │║│ Planner   │║│   Sessions     │
 *   │ (좌 내비)│║│ (중앙)    │║│   (우측, flex) │
 *   └──────────┴─┴───────────┴─┴────────────────┘
 *
 * - 좌측·중앙은 paneLeftWidth / paneMiddleWidth (uiStore에 persist)
 * - 우측은 phone 피드와 같은 세션 분류 화면을 렌더한다.
 * - 채팅은 업무 선택 시 FolderWorkspaceReadOverlay 안에서만 열린다.
 * - 스플리터 드래그는 setPaneLeftWidth / setPaneMiddleWidth가 clamp(180-360 / 280-600)
 */
export function ThreePaneLayout() {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);

  const paneLeftWidth = useUIStore((s) => s.paneLeftWidth);
  const paneMiddleWidth = useUIStore((s) => s.paneMiddleWidth);
  const folderOverlayVisible = useUIStore((s) => s.folderOverlayVisible);
  const setPaneLeftWidth = useUIStore((s) => s.setPaneLeftWidth);
  const setPaneMiddleWidth = useUIStore((s) => s.setPaneMiddleWidth);

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right']}>
      <TabletSafeAreaFrame>
        <View
          pointerEvents={folderOverlayVisible ? 'none' : 'auto'}
          style={styles.row}
        >
          <SplitPanelSurface testID="split-panel-sidebar" style={[styles.pane, { width: paneLeftWidth }]}>
            <SidebarPane showSearch />
          </SplitPanelSurface>
          <Splitter initialWidth={paneLeftWidth} onWidthChange={setPaneLeftWidth} />
          <SplitPanelSurface testID="split-panel-main" style={[styles.pane, { width: paneMiddleWidth }]}>
            <MainListPane />
          </SplitPanelSurface>
          <Splitter
            initialWidth={paneMiddleWidth}
            onWidthChange={setPaneMiddleWidth}
          />
          <SplitPanelSurface testID="split-panel-session" style={[styles.pane, { flex: 1 }]}>
            <TabletSessionFeedPane />
          </SplitPanelSurface>
        </View>
        <TabletHomeComposerHost />
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
  });
}
