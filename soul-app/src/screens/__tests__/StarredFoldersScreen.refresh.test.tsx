jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('../../hooks/usePlannerStarred', () => ({ usePlannerStarred: () => mockState }));
jest.mock('../../hooks/usePlannerContextMenus', () => ({ usePlannerContextMenus: () => ({ openFolderMenu: jest.fn() }) }));
import { act, render } from '@testing-library/react-native';
import { RefreshControl, StyleSheet } from 'react-native';
import { StarredFoldersScreen } from '../StarredFoldersScreen';
import { useSettingsStore } from '../../store/settingsStore';

const folder = {
  page: { id: 'starred-1', title: '별표 업무', version: 1,
    archived: false, metadata: { starred: true }, createdAt: '', updatedAt: '' },
  blocks: [], folderId: 'task-1', folderSummary: null, status: 'open', assignee: '담당 미확인',
  contextCount: 0, progress: null, projectPageId: null, sessions: [], sessionIds: [],
};

let mockState: any;
beforeEach(() => {
  useSettingsStore.setState({ serverUrl: '' });
  mockState = { data: { items: [folder], nextCursor: null }, loading: false, error: null, refreshRequired: false,
    refresh: jest.fn(), loadMore: jest.fn(), moveFolderOrder: jest.fn(), reordering: false };
});

test('보일 데이터가 없는 첫 로딩은 구석 표시 대신 프레임 가운데 부품을 세운다', () => {
  mockState.data = { items: [], nextCursor: null };
  mockState.loading = true;
  const screen = render(<StarredFoldersScreen />);
  expect(screen.queryByLabelText('자동 갱신 중')).toBeNull();
  expect(screen.getByTestId('starred-loading').props.accessibilityRole).toBe('progressbar');
  expect(StyleSheet.flatten(screen.getByTestId('starred-loading').props.style).flex).toBe(1);
  expect(screen.queryByText('별표 카드가 없습니다.')).toBeNull();
  expect(screen.queryByText('별표 목록을 불러오는 중입니다.')).toBeNull();
  expect(screen.queryByTestId('starred-task-sheet')).toBeNull();
});

test('첫 로딩에는 빈 유리 시트를 그리지 않고, 데이터가 있는 갱신과 빈 상태에는 그대로 둔다', () => {
  mockState.data = { items: [], nextCursor: null };
  mockState.loading = true;
  const screen = render(<StarredFoldersScreen />);
  expect(screen.queryByTestId('starred-task-sheet')).toBeNull();

  mockState.data = { items: [folder], nextCursor: null };
  screen.rerender(<StarredFoldersScreen />);
  expect(screen.getByTestId('starred-task-sheet')).toBeTruthy();
  expect(screen.getByLabelText('자동 갱신 중')).toBeTruthy();

  mockState.data = { items: [], nextCursor: null };
  mockState.loading = false;
  screen.rerender(<StarredFoldersScreen />);
  expect(screen.getByTestId('starred-task-sheet')).toBeTruthy();
  expect(screen.getByText('별표 카드가 없습니다.')).toBeTruthy();
});

test('빈 목록을 당기면 당김 스피너 하나만 돌고, 끝나면 빈 상태로 돌아온다', async () => {
  let resolve!: (value: unknown) => void;
  mockState.data = { items: [], nextCursor: null };
  mockState.loading = true;
  mockState.refresh.mockReturnValue(new Promise((ok) => { resolve = ok; }));
  const screen = render(<StarredFoldersScreen />);
  expect(screen.getByTestId('starred-loading')).toBeTruthy();

  let request!: Promise<unknown>;
  act(() => { request = screen.UNSAFE_getByType(RefreshControl).props.onRefresh(); });
  expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(true);
  expect(screen.queryByTestId('starred-loading')).toBeNull();

  await act(async () => {
    mockState.loading = false;
    resolve('refreshed');
    await request;
  });
  expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(false);
  expect(screen.queryByTestId('starred-loading')).toBeNull();
  expect(screen.getByTestId('starred-task-sheet')).toBeTruthy();
  expect(screen.getByText('별표 카드가 없습니다.')).toBeTruthy();
});

test('자동 pending 전중후는 pull을 켜지 않고 스크롤을 유지한다', () => {
  const screen = render(<StarredFoldersScreen />);
  const scroll = screen.getByTestId('starred-task-scroll');
  mockState.loading = true;
  screen.rerender(<StarredFoldersScreen />);
  expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(false);
  const progress = screen.getByLabelText('자동 갱신 중');
  expect(StyleSheet.flatten(progress.props.style).position).toBe('absolute');
  expect(progress.props.pointerEvents).toBe('none');
  expect(screen.getByTestId('starred-task-scroll')).toBe(scroll);
  mockState.loading = false;
  screen.rerender(<StarredFoldersScreen />);
  expect(screen.queryByLabelText('자동 갱신 중')).toBeNull();
  expect(screen.getByTestId('starred-task-scroll')).toBe(scroll);
});

test.each(['success', 'failed', 'reject'])('수동 당김만 pending 동안 켜지고 %s 뒤 해제한다', async (outcome) => {
  let resolve!: (result: unknown) => void;
  let reject!: (reason: Error) => void;
  mockState.refresh.mockReturnValue(new Promise((ok, fail) => { resolve = ok; reject = fail; }));
  const screen = render(<StarredFoldersScreen />);
  let request!: Promise<unknown>;
  act(() => { request = screen.UNSAFE_getByType(RefreshControl).props.onRefresh(); });
  expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(true);
  expect(screen.queryByLabelText('자동 갱신 중')).toBeNull();
  await act(async () => {
    if (outcome === 'reject') { reject(new Error('network')); await expect(request).rejects.toThrow('network'); }
    else { resolve(outcome === 'failed' ? 'failed' : 'refreshed'); await request; }
  });
  expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(false);
});
