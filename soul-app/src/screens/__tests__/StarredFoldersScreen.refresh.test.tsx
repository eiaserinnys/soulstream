jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('../../hooks/usePlannerReads', () => ({ usePlannerStarred: () => mockState }));
jest.mock('../../hooks/usePlannerContextMenus', () => ({ usePlannerContextMenus: () => ({ openFolderMenu: jest.fn() }) }));
import React from 'react';
import { act, render } from '@testing-library/react-native';
import { RefreshControl, StyleSheet } from 'react-native';
import { StarredFoldersScreen } from '../StarredFoldersScreen';
import { useSettingsStore } from '../../store/settingsStore';

let mockState: any;
beforeEach(() => {
  useSettingsStore.setState({ serverUrl: '' });
  mockState = { data: { items: [], nextCursor: null }, loading: false, error: null, refreshRequired: false,
    refresh: jest.fn(), loadMore: jest.fn(), moveFolderOrder: jest.fn(), reordering: false };
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
