jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('../../planner/FolderWorkspace', () => ({ FolderWorkspace: (props: any) => {
  const React = require('react'); const { Text, Pressable } = require('react-native');
  return React.createElement(Pressable, { testID: 'folder-existing', onPress: () => props.cardDisplay.onChange(true) },
    React.createElement(Text, null, String(props.cardDisplay?.includeCompleted)));
} }));
jest.mock('../../../screens/DailyPlannerScreen', () => ({ DailyPlannerScreen: () => require('react').createElement(require('react-native').Text, null, '기존 데일리') }));
jest.mock('../../planner/DailyHeaderActions', () => ({ DailyHeaderActions: () => null }));
jest.mock('../../../api/client', () => ({ createApiClient: () => ({ listCards: mockList, listCompletedCards: mockCompleted }) }));
jest.mock('../../planner/CardDetailSheet', () => ({ CardDetailSheet: () => null }));
import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { MainListPane } from '../MainListPane';
import { useUIStore } from '../../../store/uiStore';
import { useSettingsStore } from '../../../store/settingsStore';
import { useCardStore } from '../../../store/cardStore';
import { cardFixture } from '../../../test-support/cards';
const mockList = jest.fn();
const mockCompleted=jest.fn();

beforeEach(() => {
  useUIStore.setState({ mainPaneViews: { global: 'board' }, floatingComposerBottomInset: 0 });
  useSettingsStore.setState({ serverUrl: 'https://test.example', cardIncludeCompleted: {} });
  useCardStore.setState({ rows: {}, details: {} });
  mockList.mockReset().mockResolvedValue({ cards: [cardFixture({ id: 'draft', status: 'todo' })] });
  mockCompleted.mockReset().mockResolvedValue({cards:[cardFixture({status:'done'})],nextCursor:null});
});

test('카드 홈은 저장된 데일리 선택을 무시하고 전체 보드와 숨김·확대만 표시한다', async () => {
  useUIStore.setState({ activeSection: { kind: 'daily', date: '2026-10-01' }, mainPaneViews: { global: 'existing' } });
  const screen = render(<MainListPane showSearch />);
  expect(screen.queryByText('기존 데일리')).toBeNull();
  await waitFor(() => expect(screen.getByTestId('postit-card-draft')).toBeTruthy());
  expect(screen.queryByTestId('postit-card-card-1')).toBeNull();
  expect(mockList).toHaveBeenCalledWith(undefined,{includeCompleted:false});
  expect(screen.getByTestId('postit-card-draft')).toBeTruthy();
  expect(screen.getByLabelText('완료 숨김').props.accessibilityState.selected).toBe(true);
  await act(async () => fireEvent.press(screen.getByLabelText('완료 숨김')));
  await waitFor(()=>expect(screen.getByTestId('postit-card-card-1')).toBeTruthy());
  expect(screen.queryByLabelText('데일리 기록')).toBeNull();
  expect(screen.queryByLabelText('기존 데일리 기록')).toBeNull();
  expect(screen.queryByLabelText('카드 보드')).toBeNull();
  expect(screen.getByLabelText('보드 확대')).toBeTruthy();
  expect(screen.getAllByLabelText('드래프트 카드 추가')).toHaveLength(1);

});

test('orientation remount keeps every previously selected folder board visible', async () => {
  mockList.mockImplementation(async (folderId: string) => ({ cards: [cardFixture({ id: 'draft', status: 'todo', folderId })] }));
  useUIStore.setState({
    activeSection: { kind: 'project', folderId: 'folder-2', projectPageId: 'page-2' },
    mainPaneViews: { global: 'board', 'folder-1': 'board', 'folder-2': 'board' },
  });
  const screen = render(<MainListPane />);
  await waitFor(() => expect(screen.getByTestId('postit-card-draft')).toBeTruthy());
  expect(screen.queryByTestId('folder-existing')).toBeNull();
  await act(async () => { useUIStore.setState({
    activeSection: { kind: 'project', folderId: 'folder-1', projectPageId: 'page-1' },
  }); });
  await waitFor(() => expect(screen.getByTestId('postit-card-draft')).toBeTruthy());
  expect(screen.queryByTestId('folder-existing')).toBeNull();
});

test('폴더 기존보기·보드는 완료 옵션을 공유하고 전체로 옮겨도 폴더 옵션을 전파하지 않는다', async () => {
  useUIStore.setState({ activeSection: { kind: 'project', folderId: 'folder-1', projectPageId: 'page-1' } });
  const screen = render(<MainListPane />);
  expect(screen.getByText('false')).toBeTruthy();
  await act(async () => fireEvent.press(screen.getByLabelText('카드 보드')));
  await waitFor(() => expect(mockList).toHaveBeenCalledWith('folder-1',{includeCompleted:false}));
  expect(screen.queryByTestId('postit-card-card-1')).toBeNull();
  await act(async () => fireEvent.press(screen.getByLabelText('완료 숨김')));
  await waitFor(()=>expect(screen.getByTestId('postit-card-card-1')).toBeTruthy());
  await act(async () => fireEvent.press(screen.getByLabelText('기존 보기')));
  expect(screen.getByText('true')).toBeTruthy();
  await act(async () => useUIStore.setState({ activeSection: { kind: 'daily', date: '2026-10-01' } }));
  await waitFor(() => expect(mockList).toHaveBeenCalledWith(undefined,{includeCompleted:false}));
  expect(screen.queryByTestId('postit-card-card-1')).toBeNull();
  await act(async () => useUIStore.setState({ activeSection: { kind: 'project', folderId: 'folder-1', projectPageId: 'page-1' } }));
  await act(async () => fireEvent.press(screen.getByLabelText('카드 보드')));
  await waitFor(() => expect(screen.getByTestId('postit-card-card-1')).toBeTruthy());
});

test('보드 카드 탭은 기존 카드 오버레이를 열고 목록 오류는 재시도한다', async () => {
  useUIStore.setState({ activeSection: { kind: 'daily', date: '2026-10-01' }, selectedCardId: null });
  mockList.mockRejectedValueOnce(new Error('목록 조회 실패'));
  const screen = render(<MainListPane />);
  await waitFor(() => expect(screen.getByText('목록 조회 실패')).toBeTruthy());
  await act(async () => fireEvent.press(screen.getByLabelText('보드 다시 조회')));
  await waitFor(() => expect(screen.getByTestId('postit-card-draft')).toBeTruthy());
  await act(async () => fireEvent.press(screen.getAllByLabelText('카드 제목 카드 상세')[0]));
  expect(useUIStore.getState().selectedCardId).toBeTruthy();
});

test('상태 저장 후 상세 row가 합쳐져도 인증 목록의 최신 활동 본문을 유지한다', async () => {
  const card = cardFixture({ status: 'review', latestActivity: { kind: 'report', format: 'markdown', body: '최신 보고 원문', createdAt: '' } });
  mockList.mockResolvedValue({ cards: [card] });
  mockCompleted.mockResolvedValue({cards:[{...card,status:'done'}],nextCursor:null});
  useUIStore.setState({ activeSection: { kind: 'daily', date: '2026-10-01' } });
  const screen = render(<MainListPane />);
  await waitFor(() => expect(screen.getByText(/최신 보고 원문/)).toBeTruthy());
  const { latestActivity: _activity, ...detailRow } = card;
  await act(async () => useCardStore.getState().putCard({ ...detailRow, version: card.version + 1, status: 'done' }));
  expect(screen.queryByText(/최신 보고 원문/)).toBeNull();
  await act(async () => fireEvent.press(screen.getByLabelText('완료 숨김')));
  await waitFor(()=>expect(screen.getByText(/최신 보고 원문/)).toBeTruthy());
});

test('폴더 탭은 요청한 검색창과 기존 본문을 유지한다', () => {
  useUIStore.setState({ activeSection: { kind: 'project', folderId: 'folder-1', projectPageId: 'page-1' } });
  const screen = render(<MainListPane showSearch />);
  expect(screen.UNSAFE_getByType(require('../../search/SessionSearchField').SessionSearchField)).toBeTruthy();
  expect(screen.getByTestId('folder-existing')).toBeTruthy();
  expect(screen.queryByLabelText('보드 확대')).toBeNull();
});
