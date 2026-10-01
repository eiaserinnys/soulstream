jest.mock('expo-document-picker', () => ({}));
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('expo-image-picker', () => ({ MediaTypeOptions: { Images: 'Images' } }));
jest.mock('../../theme/useDeviceType', () => ({
  useDeviceType: () => 'phone',
  deviceTypeToBaseKey: () => 'phone',
}));
jest.mock('../../hooks/usePlannerReads', () => ({
  usePlannerDaily: () => ({ data: null, loading: false, error: null, refresh: jest.fn() }),
}));
jest.mock('../../hooks/usePlannerActions', () => ({
  usePlannerActions: () => ({ createFolder: jest.fn(), saveDailyMemo: jest.fn() }),
}));
jest.mock('../../hooks/usePlannerContextMenus', () => ({
  usePlannerContextMenus: () => ({
    openFolderMenu: jest.fn(),
    openSessionMenu: jest.fn(),
    sessionSuccession: null,
    closeSessionSuccession: jest.fn(),
  }),
}));
jest.mock('../../components/planner/DailyMemo', () => ({ DailyMemo: () => null }));
jest.mock('../../components/planner/PlannerFolderRow', () => ({ PlannerFolderRow: () => null }));
jest.mock('../../components/planner/NewFolderSheet', () => ({ NewFolderSheet: () => null }));
jest.mock('../../components/planner/SessionSuccessionHost', () => ({ SessionSuccessionHost: () => null }));
jest.mock('../../components/AppGlassCard', () => ({
  AppGlassCard: ({ children, ...props }: Record<string, any>) =>
    require('react').createElement(require('react-native').View, props, children),
}));
jest.mock('../../components/SessionCardById', () => ({
  SessionCardById: ({ sessionId }: { sessionId: string }) =>
    require('react').createElement(require('react-native').Text, null, sessionId),
}));

import React from 'react';
import { StyleSheet } from 'react-native';
import { act, render } from '@testing-library/react-native';
import { DailyPlannerScreen } from '../../screens/DailyPlannerScreen';
import { SessionFeedScreen } from '../../screens/SessionFeedScreen';
import { SettingsScreen } from '../../screens/SettingsScreen';
import { useSessionStore } from '../../store/sessionStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useNodeConnectivityStore } from '../../store/nodeConnectivityStore';
import type { Session } from '../../api/types';

beforeEach(() => {
  useSessionStore.setState({
    sessions: {},
    catalog: { folders: [], sessions: {} },
    catalogReady: false,
    feedSessionIds: [],
    sessionChangeSerial: 0,
    lastChangedSessionId: null,
  });
  useSettingsStore.setState({ serverUrl: '', appearance: 'system' });
  useNodeConnectivityStore.getState().reset();
});

beforeAll(() => jest.useFakeTimers());
afterAll(() => jest.useRealTimers());

test('representative phone bodies consume page inset20 without adding duplicate page titles', () => {
  const daily = render(<DailyPlannerScreen />);
  const dailyStyle = StyleSheet.flatten(daily.getByTestId('phone-daily-body').props.contentContainerStyle);
  expect(dailyStyle.paddingHorizontal).toBe(20);
  expect(daily.queryByText('📅 데일리')).toBeNull();
  expect(daily.getAllByText('오늘 업무')).toHaveLength(1);

  const feed = render(<SessionFeedScreen />);
  const feedStyle = StyleSheet.flatten(feed.getByTestId('phone-feed-body').props.contentContainerStyle);
  expect(feedStyle.paddingHorizontal).toBe(20);
  expect(feed.queryByText('📰 피드')).toBeNull();

  const settings = render(<SettingsScreen showTitle={false} />);
  const settingsStyle = StyleSheet.flatten(
    settings.getByTestId('phone-settings-body').props.contentContainerStyle,
  );
  expect(settingsStyle.paddingHorizontal).toBe(20);
  expect(settings.queryByText('설정')).toBeNull();

  daily.unmount();
  feed.unmount();
  settings.unmount();
  act(() => jest.runOnlyPendingTimers());
});

test('phone feed는 하단 검색 필드가 보여도 마지막 카드를 가리지 않는 여백을 예약한다', () => {
  const feed = render(<SessionFeedScreen reserveBottomSearchBarSpace />);
  const style = StyleSheet.flatten(
    feed.getByTestId('phone-feed-body').props.contentContainerStyle,
  );

  expect(style.paddingBottom).toBe(56);

  feed.unmount();
  act(() => jest.runOnlyPendingTimers());
});

test('feed projection은 source merge 뒤에도 offline running을 숨기고 reconnect에 즉시 복구한다', () => {
  const session = (agentSessionId: string, nodeId?: string): Session => ({
    agentSessionId,
    displayName: agentSessionId,
    status: 'running',
    nodeId,
    createdAt: '2026-07-20T00:00:00Z',
    updatedAt: '2026-07-20T00:00:00Z',
  });
  act(() => {
    useSessionStore.getState().setCatalog({ folders: [], sessions: {} });
    useSessionStore.getState().setSessions([
      session('online', 'node-a'),
      session('offline', 'node-b'),
      session('unknown'),
    ]);
    useNodeConnectivityStore.getState().applySnapshot([{ nodeId: 'node-a' }]);
  });

  const feed = render(<SessionFeedScreen />);
  expect(feed.getByText('online')).toBeTruthy();
  expect(feed.getByText('unknown')).toBeTruthy();
  expect(feed.queryByText('offline')).toBeNull();

  act(() => {
    useSessionStore.getState().mergeSessions([
      session('pagination-online', 'node-a'),
      session('pagination-offline', 'node-b'),
    ]);
  });
  expect(feed.getByText('pagination-online')).toBeTruthy();
  expect(feed.queryByText('pagination-offline')).toBeNull();
  expect(useSessionStore.getState().sessions['pagination-offline']).toBeTruthy();

  act(() => useNodeConnectivityStore.getState().remove({ nodeId: 'node-a' }));
  expect(feed.queryByText('online')).toBeNull();
  expect(feed.getByText('unknown')).toBeTruthy();

  act(() => useNodeConnectivityStore.getState().upsert({ nodeId: 'node-a' }));
  expect(feed.getByText('online')).toBeTruthy();
  expect(feed.getByText('pagination-online')).toBeTruthy();
});
