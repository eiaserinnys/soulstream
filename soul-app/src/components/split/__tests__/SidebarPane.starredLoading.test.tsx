jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
const mockRefresh = jest.fn(async () => 'refreshed');
let mockStarred: { items: { page: { id: string; title: string } }[]; loading: boolean } = { items: [], loading: true };
jest.mock('../../../hooks/usePlannerStarred', () => ({
  usePlannerStarred: () => ({
    data: { items: mockStarred.items, nextCursor: null },
    loading: mockStarred.loading,
    error: null,
    loadMore: jest.fn(),
    refresh: mockRefresh,
    refreshRequired: false,
    moveFolderOrder: jest.fn(),
    reordering: false,
  }),
}));
jest.mock('../../../hooks/usePlannerActions', () => ({
  usePlannerActions: () => ({ createRootFolder: jest.fn(), createFolder: jest.fn() }),
}));
jest.mock('../../../hooks/usePlannerContextMenus', () => ({
  usePlannerContextMenus: () => ({ openProjectMenu: jest.fn(), openFolderMenu: jest.fn() }),
}));
jest.mock('../../planner/StarredFolderList', () => ({
  StarredFolderList: ({ folders }: { folders: { page: { id: string; title: string } }[] }) => {
    const { Text } = require('react-native');
    const React = require('react');
    return folders.map((folder) => React.createElement(Text, { key: folder.page.id }, folder.page.title));
  },
}));
jest.mock('../../settings/SettingsModal', () => ({ SettingsModal: () => null }));
jest.mock('../../../lib/planner-folder-workspace', () => ({ openStarredPageWorkspace: jest.fn() }));

import { act, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { useSessionStore } from '../../../store/sessionStore';
import { SidebarPane } from '../SidebarPane';

const settleTimers = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 60)); });

test('iPad 사이드바 중요 작업은 첫 로딩 동안 아이폰과 같은 프레임 로딩을 보이고 불러온 뒤 목록으로 바뀐다', async () => {
  useSessionStore.setState({ catalog: { folders: [], sessions: {} } });
  mockStarred = { items: [], loading: true };
  const screen = render(<SidebarPane active />);

  expect(screen.getByTestId('sidebar-starred-loading').props.accessibilityRole).toBe('progressbar');

  mockStarred = { items: [{ page: { id: 'page-1', title: '중요 카드 하나' } }], loading: false };
  screen.rerender(<SidebarPane active />);

  expect(screen.queryByTestId('sidebar-starred-loading')).toBeNull();
  expect(screen.getByText('중요 카드 하나')).toBeTruthy();
  await settleTimers();
});

test('iPad 사이드바는 아이폰 중요 작업처럼 당겨서 중요 작업을 다시 불러온다', async () => {
  useSessionStore.setState({ catalog: { folders: [], sessions: {} } });
  mockStarred = { items: [], loading: false };
  mockRefresh.mockClear();
  const screen = render(<SidebarPane active />);
  const control = screen.getByTestId('sidebar-main-list').props.refreshControl;

  expect(control.props.refreshing).toBe(false);
  await act(async () => { await control.props.onRefresh(); });

  expect(mockRefresh).toHaveBeenCalledTimes(1);
  await settleTimers();
});

test('iPad 사이드바 카드 줄은 중요 작업, 설정과 같은 안쪽 여백에 놓인다', async () => {
  useSessionStore.setState({ catalog: { folders: [], sessions: {} } });
  mockStarred = { items: [], loading: false };
  const screen = render(<SidebarPane active />);
  const inset = (testID: string) => StyleSheet.flatten(screen.getByTestId(testID).props.style).paddingHorizontal;

  expect(inset('sidebar-daily-row')).toBe(inset('sidebar-starred-section'));
  expect(inset('sidebar-daily-row')).toBe(inset('sidebar-settings-footer'));
  await settleTimers();
});
