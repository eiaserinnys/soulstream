jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
let mockStarred: { items: { page: { id: string; title: string } }[]; loading: boolean } = { items: [], loading: true };
jest.mock('../../../hooks/usePlannerStarred', () => ({
  usePlannerStarred: () => ({
    data: { items: mockStarred.items, nextCursor: null },
    loading: mockStarred.loading,
    error: null,
    loadMore: jest.fn(),
    refresh: jest.fn(),
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
