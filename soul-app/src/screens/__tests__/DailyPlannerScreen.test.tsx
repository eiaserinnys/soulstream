import { makeSessionCardStyles } from '../../components/sessionCardFrame';
import { useTokens } from '../../theme';
jest.mock('expo-image-picker', () => ({ requestMediaLibraryPermissionsAsync: jest.fn(), launchImageLibraryAsync: jest.fn() }));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
import React from 'react';
import { act, fireEvent, render, renderHook } from '@testing-library/react-native';
import { RefreshControl, ScrollView, StyleSheet } from 'react-native';
import { parsePlannerToday, type PlannerTodayWire } from '../../api/plannerTypes';
import { useSettingsStore } from '../../store/settingsStore';
import { cardFixture } from '../../test-support/cards';
import { useCardStore } from '../../store/cardStore';
import { useUIStore } from '../../store/uiStore';
import { GlassButton } from '../../components/GlassSurface';

const mockUsePlannerDaily = jest.fn();
let mockDeviceType: 'phone' | 'tabletPortrait' = 'phone';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('../../api/client', () => ({ createApiClient: jest.fn(() => ({})) }));
jest.mock('../../hooks/usePlannerReads', () => ({
  usePlannerDaily: (...args: unknown[]) => mockUsePlannerDaily(...args),
  usePlannerPageDetail: () => ({ data: undefined, loading: false, error: null }),
}));
jest.mock('../../hooks/usePlannerContextMenus', () => ({
  usePlannerContextMenus: () => ({ openFolderMenu: jest.fn() }),
}));
jest.mock('../../hooks/usePlannerActions', () => ({
  usePlannerActions: () => ({
    saveDailyMemo: jest.fn(),
    createFolder: jest.fn(),
    setFolderToday: jest.fn(),
    completeFolder: jest.fn(),
  }),
}));
jest.mock('../../components/planner/DailyMemo', () => ({
  DailyMemo: () => require('react').createElement(
    require('react-native').View,
    { testID: 'daily-memo' },
  ),
}));
jest.mock('../../theme/useDeviceType', () => ({
  useDeviceType: () => mockDeviceType,
  deviceTypeToBaseKey: (device: string) => device === 'phone' ? 'phone' : 'tablet',
}));
jest.mock('../../components/planner/NewFolderSheet', () => ({
  NewFolderSheet: ({ visible }: { visible: boolean }) => visible
    ? require('react').createElement(require('react-native').View, { testID: 'new-task-sheet-open' })
    : null,
}));
jest.mock('../../components/planner/MorningReviewSheet', () => ({
  MorningReviewSheet: ({ visible }: { visible: boolean }) => visible
    ? require('react').createElement(require('react-native').View, { testID: 'morning-review-sheet-open' })
    : null,
}));

jest.mock('../../components/sheets/useNewSessionSelection', () => ({ useNewSessionSelection: () => ({ selectedAgentName: '로젤린', selectedModelPresetName: 'Sol 6.1' }) }));
jest.mock('../../components/planner/CardQueue', () => ({ CardQueue: () => null }));
jest.mock('../../components/planner/CardAssignmentSheet', () => ({ CardAssignmentSheet: () => null }));

import { DailyPlannerScreen, type DailyPlannerScreenHandle } from '../DailyPlannerScreen';

beforeEach(() => {
  useCardStore.setState({ rows: {}, details: {} });
  mockUsePlannerDaily.mockReset();
  mockDeviceType = 'phone';
  useSettingsStore.setState({ serverUrl: 'https://planner.test' });
  useUIStore.setState({ todayDate: '2026-07-17' });
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('review와 모든 blocked 종류를 표시하고 날짜 머리는 키커·한국어 날짜·오른쪽 캡 두 개다', () => {
  const data = parsePlannerToday(canonicalTodayFixture());
  mockUsePlannerDaily.mockReturnValue({
    data,
    loading: false,
    error: null,
    refresh: jest.fn(),
  });

  const screen = render(<DailyPlannerScreen date="2026-07-17" />);

  expect(screen.getByText('확인할 것')).toBeTruthy();
  for (const kind of ['review', 'question', 'no_report', 'limit']) expect(screen.getByText(`카드 ${kind}`)).toBeTruthy();
  expect(screen.queryByTestId('today-cards-running')).toBeNull();
  expect(screen.queryByTestId('today-cards-queued')).toBeNull();
  expect(screen.queryByText('오늘 업무')).toBeNull();
  expect(screen.getByText('DAILY')).toBeTruthy();
  expect(screen.getByTestId('daily-centered-date')).toHaveTextContent('7월 17일 금요일');
  expect(screen.queryByTestId('daily-card-summary')).toBeNull();
  expect(screen.queryByText('◀')).toBeNull();
  expect(screen.queryByText('▶')).toBeNull();
  const dateStyle = StyleSheet.flatten(screen.getByTestId('daily-centered-date').props.style);
  expect(dateStyle).toMatchObject({ fontSize: 20, lineHeight: 26 });
  expect(dateStyle.textAlign).not.toBe('center');
  const caps = screen.UNSAFE_getAllByType(GlassButton).filter((node) =>
    ['이전 날짜', '다음 날짜'].includes(node.props.accessibilityLabel));
  expect(caps).toHaveLength(2);
  for (const cap of caps) {
    expect(cap.props.iconOnly).toBe(true);
    const style = StyleSheet.flatten(screen.getByLabelText(cap.props.accessibilityLabel).props.style);
    expect(style).toMatchObject({ width: 44, height: 44, borderRadius: 999 });
  }
});

test('본문 생성 action을 제거하고 root header handle이 기존 두 sheet 단일 경로를 연다', () => {
  mockUsePlannerDaily.mockReturnValue({ data: undefined, loading: false, error: null, refresh: jest.fn() });
  const ref = React.createRef<DailyPlannerScreenHandle>();
  const screen = render(<DailyPlannerScreen ref={ref} date="2026-07-17" />);
  expect(screen.queryByText('새 업무')).toBeNull();
  act(() => ref.current?.openNewFolder());
  expect(screen.getByTestId('new-task-sheet-open')).toBeTruthy();
  act(() => ref.current?.openReview());
  expect(screen.getByTestId('morning-review-sheet-open')).toBeTruthy();
});

test.each(['phone', 'tabletPortrait'] as const)('%s 카드 묶음은 폴더 화면과 같은 섹션 간격을 쓴다', (device) => {
  mockDeviceType = device;
  mockUsePlannerDaily.mockReturnValue({ data: parsePlannerToday(canonicalTodayFixture()), loading: false, error: null, refresh: jest.fn() });
  const screen = render(<DailyPlannerScreen date="2026-07-17" />);
  expect(StyleSheet.flatten(screen.getByTestId('today-cards').props.style)).toMatchObject({ gap: 16 });
  expect(StyleSheet.flatten(screen.getByTestId('today-cards-attention').props.style)).toMatchObject({ gap: 8 });
});

test.each(['phone', 'tabletPortrait'] as const)(
  '%s cached 자동 로딩은 date/memo flow나 pull spinner를 바꾸지 않는다',
  (device) => {
    mockDeviceType = device;
    const state = {
      data: parsePlannerToday(canonicalTodayFixture()),
      loading: false,
      error: null,
      refresh: jest.fn(),
    };
    mockUsePlannerDaily.mockImplementation(() => state);

    const screen = render(<DailyPlannerScreen date="2026-07-17" />);
    const dateStyleBefore = StyleSheet.flatten(screen.getByTestId('daily-date-row').props.style);
    const memoParentBefore = screen.getByTestId('daily-memo').parent;

    state.loading = true;
    screen.rerender(<DailyPlannerScreen date="2026-07-17" />);
    const refreshControl = screen.UNSAFE_getByType(RefreshControl);
    const scroll = screen.getByTestId('phone-daily-body');
    const progressStyle = StyleSheet.flatten(screen.getByTestId('daily-auto-progress').props.style);

    expect(refreshControl.props.refreshing).toBe(false);
    expect(progressStyle.position).toBe('absolute');
    expect(StyleSheet.flatten(screen.getByTestId('daily-date-row').props.style)).toEqual(dateStyleBefore);
    expect(screen.getByTestId('daily-memo').parent).toBe(memoParentBefore);
    expect(scroll.props.contentInset).toMatchObject({ top: 0 });
    expect(scroll.props.contentOffset).toBeUndefined();
  },
);

test('manual pull만 refreshing을 켜고 reject 뒤에도 finally에서 해제한다', async () => {
  let rejectRefresh!: (cause: Error) => void;
  const refresh = jest.fn(() => new Promise<void>((_resolve, reject) => {
    rejectRefresh = reject;
  }));
  mockUsePlannerDaily.mockReturnValue({
    data: parsePlannerToday(canonicalTodayFixture()),
    loading: true,
    error: null,
    refresh,
  });
  const screen = render(<DailyPlannerScreen date="2026-07-17" />);

  let refreshPromise!: Promise<void>;
  await act(async () => {
    refreshPromise = screen.UNSAFE_getByType(RefreshControl).props.onRefresh();
  });
  expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(true);
  expect(screen.queryByTestId('daily-auto-progress')).toBeNull();
  await act(async () => {
    rejectRefresh(new Error('network'));
    await expect(refreshPromise).rejects.toThrow('network');
  });
  expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(false);
});

test('날짜 action은 상태 변경 전에, inactive→active는 layout 경계에서 y0으로 한 번만 정렬한다', () => {
  const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => undefined);
  const state = {
    data: parsePlannerToday(canonicalTodayFixture()),
    loading: false,
    error: null,
    refresh: jest.fn(),
  };
  mockUsePlannerDaily.mockImplementation(() => state);
  const onDateChange = jest.fn();
  const screen = render(
    <DailyPlannerScreen date="2026-07-17" active={false} onDateChange={onDateChange} />,
  );

  fireEvent.press(screen.getByLabelText('다음 날짜'));
  expect(scrollTo).toHaveBeenLastCalledWith({ y: 0, animated: false });
  expect(scrollTo.mock.invocationCallOrder[0]).toBeLessThan(onDateChange.mock.invocationCallOrder[0]);
  expect(scrollTo).toHaveBeenCalledTimes(1);

  screen.rerender(
    <DailyPlannerScreen date="2026-07-18" active={false} onDateChange={onDateChange} />,
  );
  expect(scrollTo).toHaveBeenCalledTimes(1);

  state.loading = true;
  screen.rerender(
    <DailyPlannerScreen date="2026-07-18" active={false} onDateChange={onDateChange} />,
  );
  expect(scrollTo).toHaveBeenCalledTimes(1);

  screen.rerender(
    <DailyPlannerScreen date="2026-07-18" active onDateChange={onDateChange} />,
  );
  expect(scrollTo).toHaveBeenLastCalledWith({ y: 0, animated: false });
  expect(scrollTo).toHaveBeenCalledTimes(2);
});

function canonicalTodayFixture(): PlannerTodayWire {
  const page = {
    id: 'task-page',
    title: '업무',
    daily_date: null,
    version: 3,
    archived: false,
    metadata: {},
    created_at: '2026-07-17T00:00:00Z',
    updated_at: '2026-07-17T00:00:00Z',
  };
  return {
    daily: {
      page: { ...page, id: 'daily', title: '2026-07-17', daily_date: '2026-07-17' },
      blocks: [],
      state_vector: 'sv',
    },
    memoBlocks: [],
    folders: [{
      page,
      folder: {
        id: 'task-id',
        name: '업무',
        sortOrder: 0,
        parentFolderId: 'project-1',
        projectPageId: 'task-page',
        settings: {},
        status: 'open',
        archived: false,
        version: 2,
      },
      itemCounts: { pending: 1 },
      itemTotal: 1,
      completedItemCount: 0,
      assignee: null,
    }],
    attention: [cardFixture({ title: '카드 review', status: 'review' }), ...(['question', 'no_report', 'limit'] as const).map((kind) => cardFixture({ id: kind, title: `카드 ${kind}`, status: 'blocked', blockedKind: kind }))], running: [], queued: [],
    reviewSessionIds: [],
  };
}

test.each(['phone', 'tabletPortrait'] as const)('%s 빈 묶음은 생략하고 메모 다음 목록, 스크롤 밖 입력창을 둔다', (device) => {
  mockDeviceType = device;
  const data = parsePlannerToday(canonicalTodayFixture());
  data.attention = []; data.running = []; data.queued = [];
  mockUsePlannerDaily.mockReturnValue({ data, loading: false, error: null, refresh: jest.fn() });
  const screen = render(<DailyPlannerScreen date="2026-07-17" />);
  expect(screen.getByTestId('today-cards-attention')).toBeTruthy();
  expect(screen.getByText('+ 카드')).toBeTruthy();
  expect(screen.queryByTestId('today-cards-running')).toBeNull();
  expect(screen.queryByTestId('today-cards-queued')).toBeNull();
  expect(screen.getAllByText('지금은 확인할 것이 없습니다')).toHaveLength(1);
  expect(screen.queryByTestId('daily-card-summary')).toBeNull();
  const scroll = screen.UNSAFE_getByType(ScrollView);
  expect(scroll.findAll((node) => node.props.testID === 'card-composer')).toHaveLength(0);
  expect(screen.getByTestId('card-composer')).toBeTruthy();
  const children = scroll.props.children.filter(Boolean);
  expect(children.findIndex((node: any) => node.type?.name === 'DailyMemo')).toBeLessThan(children.findIndex((node: any) => node.type?.name === 'TodayCards'));
  expect(StyleSheet.flatten(screen.getByTestId('daily-composer-dock').props.style).paddingHorizontal).toBe(16);
});

test('날짜 요약 없이 묶음 제목 옆 개수가 실시간 카드 상태를 센다', () => {
  const data = parsePlannerToday(canonicalTodayFixture());
  data.running = [cardFixture({ id: 'running', status: 'running' })];
  data.queued = [cardFixture({ id: 'queued', status: 'queued' })];
  mockUsePlannerDaily.mockReturnValue({ data, loading: false, error: null, refresh: jest.fn() });
  const screen = render(<DailyPlannerScreen date="2026-07-17" />);
  expect(screen.queryByTestId('daily-card-summary')).toBeNull();
  expect(screen.getByText('4')).toBeTruthy();
  act(() => useCardStore.setState({ rows: { ...useCardStore.getState().rows, 'card-1': cardFixture({ id: 'card-1', status: 'done' }) } }));
  expect(screen.queryByTestId('daily-card-summary')).toBeNull();
  expect(screen.getByText('3')).toBeTruthy();
});


test.each(['phone', 'tabletPortrait'] as const)('%s 오늘 행은 세션 카드 프레임·제목·초상과 원형 동작을 쓴다', (device) => {
  mockDeviceType = device;
  mockUsePlannerDaily.mockReturnValue({ data: parsePlannerToday(canonicalTodayFixture()), loading: false, error: null, refresh: jest.fn() });
  const screen = render(<DailyPlannerScreen date="2026-07-17" />);
  expect(StyleSheet.flatten(screen.getByTestId('card-row-card-1-layout').props.style)).toMatchObject({ minHeight: 112, alignItems: 'center' });
  expect(StyleSheet.flatten(screen.getByTestId('card-card-1-avatar').props.style).width).toBe(44);
  expect(StyleSheet.flatten(screen.getByText('카드 review').props.style).fontSize).toBe(makeSessionCardStyles(renderHook(() => useTokens()).result.current, true).name.fontSize);
  expect(StyleSheet.flatten(screen.getByTestId('card-card-1-완료-visual').props.style)).toMatchObject({ width: 44, height: 44, borderRadius: 999 });
  expect(StyleSheet.flatten(screen.getByTestId('card-composer').props.style).borderRadius).toBe(16);
});
