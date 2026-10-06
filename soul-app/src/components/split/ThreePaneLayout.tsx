import React, { useMemo, useState } from 'react';
import { View, StyleSheet, useWindowDimensions } from 'react-native';
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
import {
  clampThreePaneLeftDrag,
  clampThreePaneMiddleDrag,
  resolveThreePaneWidths,
} from './paneWidths';

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
 * - 각 칸은 최소 폭을 지키고, 오른쪽 피드에 남은 폭을 배분한다.
 */
export function ThreePaneLayout() {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const { width: windowWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [measuredRowWidth, setMeasuredRowWidth] = useState<number | null>(null);

  const paneLeftWidth = useUIStore((s) => s.paneLeftWidth);
  const paneMiddleWidth = useUIStore((s) => s.paneMiddleWidth);
  const folderOverlayVisible = useUIStore((s) => s.folderOverlayVisible);
  const setThreePaneWidths = useUIStore((s) => s.setThreePaneWidths);
  const rowWidth = measuredRowWidth
    ?? windowWidth - insets.left - insets.right - 2 * t.tabletShell.outerInset;
  const paneWidths = resolveThreePaneWidths({
    rowWidth,
    panelGap: t.tabletShell.panelGap,
    paneLeftWidth,
    paneMiddleWidth,
  });

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right']}>
      <TabletSafeAreaFrame>
        <View
          pointerEvents={folderOverlayVisible ? 'none' : 'auto'}
          style={styles.row}
          onLayout={({ nativeEvent }) => setMeasuredRowWidth(nativeEvent.layout.width)}
        >
          <SplitPanelSurface testID="split-panel-sidebar" style={[styles.pane, { width: paneWidths.left }]}>
            <SidebarPane showSearch />
          </SplitPanelSurface>
          <Splitter
            initialWidth={paneWidths.left}
            onWidthChange={(width) => setThreePaneWidths(
              clampThreePaneLeftDrag(width, {
                rowWidth,
                panelGap: t.tabletShell.panelGap,
                middle: paneWidths.middle,
              }),
              paneWidths.middle,
            )}
          />
          <SplitPanelSurface testID="split-panel-main" style={[styles.pane, { width: paneWidths.middle }]}>
            <MainListPane />
          </SplitPanelSurface>
          <Splitter
            initialWidth={paneWidths.middle}
            onWidthChange={(width) => setThreePaneWidths(
              paneWidths.left,
              clampThreePaneMiddleDrag(width, {
                rowWidth,
                panelGap: t.tabletShell.panelGap,
                left: paneWidths.left,
              }),
            )}
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
