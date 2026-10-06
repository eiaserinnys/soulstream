import React from 'react';
import * as ReactNative from 'react-native';
import { StyleSheet, View } from 'react-native';
import {
  SafeAreaProvider,
  SafeAreaView,
  type Metrics,
} from 'react-native-safe-area-context';
import { act, fireEvent, render } from '@testing-library/react-native';
import { ThreePaneLayout } from '../ThreePaneLayout';
import { TwoPaneWithDrawer } from '../TwoPaneWithDrawer';
import { TabletSafeAreaFrame } from '../TabletSafeAreaFrame';
import { useUIStore } from '../../../store/uiStore';
import { useSearchStore } from '../../../store/searchStore';

const mockOpenPlannerSessionWorkspace = jest.fn();
const mockOpenFeedSessionCardWorkspace = jest.fn();

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('../SidebarPane', () => ({
  SidebarPane: () => require('react').createElement(require('react-native').View, { testID: 'planner-navigation' }),
}));
jest.mock('../MainListPane', () => ({
  MainListPane: () => require('react').createElement(require('react-native').View, { testID: 'planner-main' }),
}));
jest.mock('../Splitter', () => ({
  Splitter: ({ onWidthChange }: { onWidthChange: (width: number) => void }) => require('react').createElement(
    require('react-native').View,
    { testID: 'splitter', onWidthChange },
  ),
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
jest.mock('../../../lib/session-feed-card-workspace', () => ({
  openFeedSessionCardWorkspace: (...args: unknown[]) => mockOpenFeedSessionCardWorkspace(...args),
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
    mockOpenFeedSessionCardWorkspace.mockClear();
    useSearchStore.getState().reset();
    useUIStore.setState({
      folderOverlayVisible: false,
      paneLeftWidth: 240,
      paneMiddleWidth: 480,
      paneMiddleWidthTwoPane: null,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
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
    expect(mockOpenFeedSessionCardWorkspace).toHaveBeenCalledWith('session-1');
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

  it('저장된 가운데 폭 700을 넓은 가로 행에서 그대로 렌더링한다', () => {
    useUIStore.setState({ paneMiddleWidth: 700 });
    const screen = render(<ThreePaneLayout />);
    fireLayout(screen, 1400);

    expect(StyleSheet.flatten(screen.getByTestId('split-panel-main').props.style).width).toBe(700);
  });

  it('가로 사이드바를 끌면 보이는 가운데 폭을 함께 저장해 되살아나지 않게 한다', async () => {
    useUIStore.setState({ paneLeftWidth: 240, paneMiddleWidth: 700 });
    const screen = render(<ThreePaneLayout />);
    fireLayout(screen, 1170);

    expect(StyleSheet.flatten(screen.getByTestId('split-panel-sidebar').props.style).width).toBe(240);
    expect(StyleSheet.flatten(screen.getByTestId('split-panel-main').props.style).width).toBe(606);

    const leftSplitter = screen.getAllByTestId('splitter')[0];
    await act(async () => leftSplitter.props.onWidthChange(200));

    expect(StyleSheet.flatten(screen.getByTestId('split-panel-sidebar').props.style).width).toBe(200);
    expect(StyleSheet.flatten(screen.getByTestId('split-panel-main').props.style).width).toBe(606);
    expect(useUIStore.getState()).toMatchObject({ paneLeftWidth: 200, paneMiddleWidth: 606 });
  });

  it('가로 사이드바 드래그는 예전 360pt 상한에서 멈추지 않는다', async () => {
    useUIStore.setState({ paneLeftWidth: 240, paneMiddleWidth: 280 });
    const screen = render(<ThreePaneLayout />);
    fireLayout(screen, 1400);

    const leftSplitter = screen.getAllByTestId('splitter')[0];
    await act(async () => leftSplitter.props.onWidthChange(500));

    expect(StyleSheet.flatten(screen.getByTestId('split-panel-sidebar').props.style).width).toBe(500);
    expect(useUIStore.getState().paneLeftWidth).toBe(500);
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
    expect(mockOpenFeedSessionCardWorkspace).toHaveBeenCalledWith('session-1');
  });

  it('세로 저장 폭은 화면 절반보다 커도 현재 폭으로 렌더링한다', () => {
    jest.spyOn(ReactNative, 'useWindowDimensions').mockReturnValue({
      width: 834,
      height: 1194,
      scale: 1,
      fontScale: 1,
    });
    useUIStore.getState().setPaneMiddleWidthTwoPane(480);
    const screen = render(<TwoPaneWithDrawer />);
    fireLayout(screen, 810);

    expect(480).toBeGreaterThan(Math.floor(834 * 0.5));
    expect(StyleSheet.flatten(screen.getByTestId('split-panel-main').props.style).width).toBe(480);
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

function fireLayout(screen: ReturnType<typeof render>, width: number) {
  const row = screen.UNSAFE_getAllByType(View).find((node) => {
    const style = StyleSheet.flatten(node.props.style);
    return style?.flexDirection === 'row';
  });
  if (!row) throw new Error('split 행의 onLayout을 찾지 못했습니다.');

  fireEvent(row, 'layout', {
    nativeEvent: { layout: { width, height: 800, x: 0, y: 0 } },
  });
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
