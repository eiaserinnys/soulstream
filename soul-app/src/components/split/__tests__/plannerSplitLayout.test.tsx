import React from 'react';
import { StyleSheet, View } from 'react-native';
import {
  SafeAreaProvider,
  SafeAreaView,
  type Metrics,
} from 'react-native-safe-area-context';
import { fireEvent, render } from '@testing-library/react-native';
import { ThreePaneLayout } from '../ThreePaneLayout';
import { TwoPaneWithDrawer } from '../TwoPaneWithDrawer';
import { TabletSafeAreaFrame } from '../TabletSafeAreaFrame';
import { useUIStore } from '../../../store/uiStore';
import { useSearchStore } from '../../../store/searchStore';

const mockOpenPlannerSessionWorkspace = jest.fn();

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('../SidebarPane', () => ({
  SidebarPane: () => require('react').createElement(require('react-native').View, { testID: 'planner-navigation' }),
}));
jest.mock('../MainListPane', () => ({
  MainListPane: () => require('react').createElement(require('react-native').View, { testID: 'planner-main' }),
}));
jest.mock('../Splitter', () => ({
  Splitter: () => require('react').createElement(require('react-native').View, { testID: 'splitter' }),
}));
jest.mock('../../../screens/SessionFeedScreen', () => ({
  SessionFeedScreen: ({ onOpenSession }: { onOpenSession?: (sessionId: string) => void }) => (
    require('react').createElement(
      require('react-native').TouchableOpacity,
      {
        testID: 'planner-sessions',
        onPress: () => onOpenSession?.('session-1'),
      },
    )
  ),
}));
jest.mock('../../planner/FolderWorkspaceReadOverlay', () => ({
  FolderWorkspaceReadOverlay: () => require('react').createElement(require('react-native').View, { testID: 'task-workspace-overlay' }),
}));
jest.mock('../../../lib/planner-folder-workspace', () => ({
  openPlannerSessionWorkspace: (...args: unknown[]) => mockOpenPlannerSessionWorkspace(...args),
}));
jest.mock('../../../screens/SearchScreen', () => ({
  SearchScreen: ({ onOpenSession }: {
    onOpenSession: (sessionId: string, eventId?: number, storyOpenRequestId?: number) => void;
  }) => require('react').createElement(require('react-native').TouchableOpacity, {
    testID: 'planner-search-session',
    onPress: () => onOpenSession('search-session', 42, 9),
  }),
}));

describe('iPad v3 planner shell', () => {
  beforeEach(() => {
    mockOpenPlannerSessionWorkspace.mockClear();
    useSearchStore.getState().reset();
    useUIStore.setState({ folderOverlayVisible: false });
  });

  it('가로는 좌 내비·중앙 플래너·우 세션의 3열과 업무 오버레이를 공유한다', () => {
    const screen = render(<ThreePaneLayout />);

    expect(screen.getByTestId('planner-navigation')).toBeTruthy();
    expect(screen.getByTestId('planner-main')).toBeTruthy();
    expect(screen.getByTestId('planner-sessions')).toBeTruthy();
    expect(screen.getByTestId('split-panel-sidebar')).toBeTruthy();
    expect(screen.getByTestId('split-panel-main')).toBeTruthy();
    expect(screen.getByTestId('split-panel-session')).toBeTruthy();
    expect(screen.getByTestId('task-workspace-overlay')).toBeTruthy();
    expectPanelRadius(screen.getByTestId('split-panel-sidebar'), 24);
    expectPanelRadius(screen.getByTestId('split-panel-main'), 24);
    expectPanelRadius(screen.getByTestId('split-panel-session'), 24);
    const frame = screen.getByTestId('tablet-safe-area-frame');
    expect(frame.findByProps({ testID: 'planner-main' })).toBeTruthy();
    expect(frame.findByProps({ testID: 'task-workspace-overlay' })).toBeTruthy();

    fireEvent.press(screen.getByTestId('planner-sessions'));
    expect(mockOpenPlannerSessionWorkspace).toHaveBeenCalledWith(
      'session-1',
      undefined,
      undefined,
      'feed',
    );
  });

  it('검색 세션 선택도 피드와 같은 업무 resolver entrypoint와 event/story 문맥을 사용한다', () => {
    useSearchStore.getState().openTabletSearch();
    const screen = render(<ThreePaneLayout />);

    fireEvent.press(screen.getByTestId('planner-search-session'));

    expect(mockOpenPlannerSessionWorkspace).toHaveBeenCalledWith(
      'search-session',
      42,
      9,
      'search',
    );
  });

  it.each([
    ['safe inset 없음', createMetrics(0, 0)],
    ['상단 31pt·하단 34pt', createMetrics(31, 34)],
  ])('%s에서도 메인 split과 absolute 오버레이는 같은 12pt 시각 여백 정본을 쓴다', (
    _label,
    metrics,
  ) => {
    const screen = renderWithMetrics(
      <TabletSafeAreaFrame>
        <View testID="main-content" />
        <View testID="overlay-content" />
      </TabletSafeAreaFrame>,
      metrics,
    );
    const frame = screen.getByTestId('tablet-safe-area-frame');
    expect(StyleSheet.flatten(frame.props.style).marginTop).toBe(metrics.insets.top);
    expect(StyleSheet.flatten(frame.props.style)).toEqual(
      expect.objectContaining({
        paddingTop: 12,
        paddingBottom: 12,
        paddingHorizontal: 12,
      }),
    );
    expect(screen.getByTestId('tablet-safe-area-content')).toBeTruthy();
    expect(frame.findByProps({ testID: 'main-content' })).toBeTruthy();
    expect(frame.findByProps({ testID: 'overlay-content' })).toBeTruthy();
  });

  it('세로는 좌 내비를 drawer로 축약하고 중앙·우 세션·업무 오버레이를 유지한다', () => {
    const screen = render(<TwoPaneWithDrawer />);

    expect(screen.getByTestId('planner-navigation')).toBeTruthy();
    expect(screen.getByTestId('planner-main')).toBeTruthy();
    expect(screen.getByTestId('planner-sessions')).toBeTruthy();
    expect(screen.getByTestId('split-panel-sidebar')).toBeTruthy();
    expect(screen.getByTestId('split-panel-main')).toBeTruthy();
    expect(screen.getByTestId('split-panel-session')).toBeTruthy();
    expect(screen.getByTestId('task-workspace-overlay')).toBeTruthy();
    expectPanelRadius(screen.getByTestId('split-panel-sidebar'), 24);
    expectPanelRadius(screen.getByTestId('split-panel-main'), 24);
    expectPanelRadius(screen.getByTestId('split-panel-session'), 24);

    fireEvent.press(screen.getByTestId('planner-sessions'));
    expect(mockOpenPlannerSessionWorkspace).toHaveBeenCalledWith(
      'session-1',
      undefined,
      undefined,
      'feed',
    );
  });

  it.each([
    ['가로', ThreePaneLayout],
    ['세로', TwoPaneWithDrawer],
  ])('%s split 행은 스플리터를 내부에 가두고 업무 오버레이가 열리면 터치를 잠근다', (_label, Layout) => {
    useUIStore.setState({ folderOverlayVisible: true });

    const screen = render(React.createElement(Layout));
    const splitContent = screen.UNSAFE_getAllByType(View).find((node) =>
      StyleSheet.flatten(node.props.style).flexDirection === 'row'
        && node.props.pointerEvents === 'none',
    );

    expect(splitContent).toBeTruthy();
    expect(StyleSheet.flatten(splitContent!.props.style)).toEqual(
      expect.objectContaining({
        isolation: 'isolate',
        zIndex: 0,
      }),
    );
  });

  it.each([
    ['가로', ThreePaneLayout],
    ['세로', TwoPaneWithDrawer],
  ])('%s shell은 큰 bottom inset도 바깥 12pt 여백에 더하지 않는다', (_label, Layout) => {
    const screen = renderWithMetrics(
      React.createElement(Layout),
      createMetrics(31, 34),
    );
    const safeArea = screen.UNSAFE_getByType(SafeAreaView);
    const frame = screen.getByTestId('tablet-safe-area-frame');

    expect(safeArea.props.edges).toEqual(['left', 'right']);
    expect(StyleSheet.flatten(frame.props.style)).toEqual(expect.objectContaining({
      marginTop: 31,
      paddingTop: 12,
      paddingBottom: 12,
      paddingHorizontal: 12,
    }));
    expect(frame.findByProps({ testID: 'task-workspace-overlay' })).toBeTruthy();
  });
});

function createMetrics(top: number, bottom: number): Metrics {
  return {
    frame: { x: 0, y: 0, width: 1024, height: 1366 },
    insets: { top, bottom, left: 0, right: 0 },
  };
}

function renderWithMetrics(element: React.ReactElement, metrics: Metrics) {
  return render(
    <SafeAreaProvider initialMetrics={metrics}>
      {element}
    </SafeAreaProvider>,
  );
}

function expectPanelRadius(
  node: { props: { style?: unknown } },
  radius: number,
) {
  expect(StyleSheet.flatten(node.props.style)).toEqual(expect.objectContaining({
    borderRadius: radius,
    borderTopLeftRadius: radius,
    borderTopRightRadius: radius,
    borderBottomLeftRadius: radius,
    borderBottomRightRadius: radius,
  }));
}
