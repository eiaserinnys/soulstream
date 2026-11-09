jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('react-native-gesture-handler', () => ({ ...jest.requireActual('react-native-gesture-handler'), GestureHandlerRootView: require('react-native').View }));
jest.mock('../../planner/FolderWorkspace', () => ({ FolderWorkspace: (props: any) => {
  const React = require('react'); const { Text, Pressable } = require('react-native');
  return React.createElement(Pressable, { testID: 'folder-existing', onPress: () => props.cardDisplay.onChange(true) },
    React.createElement(Text, null, String(props.cardDisplay?.includeCompleted)));
} }));
jest.mock('../../../screens/DailyPlannerScreen', () => ({ DailyPlannerScreen: () => require('react').createElement(require('react-native').Text, null, '기존 데일리') }));
jest.mock('../../planner/DailyHeaderActions', () => ({ DailyHeaderActions: () => null }));
jest.mock('../../../api/client', () => ({ createApiClient: () => ({ listCards: mockList, listCompletedCards: mockCompleted, listNodes: async () => ({ nodes: [] }) }) }));
jest.mock('../../planner/CardDetailSheet', () => ({ CardDetailSheet: () => null }));
import React from 'react';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import { MainListPane } from '../MainListPane';
import { useUIStore } from '../../../store/uiStore';
import { useSettingsStore } from '../../../store/settingsStore';
import { useCardStore } from '../../../store/cardStore';
import { useSessionStore } from '../../../store/sessionStore';
import { cardFixture } from '../../../test-support/cards';
import { DuoSideBandContext, DuoTopBandMainContext } from '../../../navigation/tabContract';
const mockList = jest.fn();
const mockCompleted=jest.fn();

test('듀오 세로 메인에서만 패널 머리줄을 띠에 맡긴다', async () => {
  useUIStore.setState({ activeSection: { kind: 'daily', date: '2026-10-01' } });
  const screen = render(<DuoSideBandContext.Provider value={false}><DuoTopBandMainContext.Provider value={true}>
    <MainListPane showSearch />
  </DuoTopBandMainContext.Provider></DuoSideBandContext.Provider>);
  expect(screen.queryByTestId('tablet-main-header')).toBeNull();
  screen.rerender(<DuoSideBandContext.Provider value={false}><DuoTopBandMainContext.Provider value={false}>
    <MainListPane showSearch />
  </DuoTopBandMainContext.Provider></DuoSideBandContext.Provider>);
  expect(screen.getByTestId('tablet-main-header')).toBeTruthy();
  await waitFor(() => expect(screen.getByTestId('postit-card-draft')).toBeTruthy());
  screen.unmount();
});

test('듀오 프로젝트에서는 본문 탭 없이 레일의 보기 변경을 반영한다', async () => {
  useUIStore.setState({ activeSection: { kind: 'project', folderId: 'folder-1', projectPageId: 'page-1' }, mainPaneViews: {} });
  const screen = render(<DuoSideBandContext.Provider value={true}><MainListPane showSearch paneWidth={333} /></DuoSideBandContext.Provider>);
  expect(screen.queryByTestId('tablet-main-header')).toBeNull();
  expect(screen.queryByLabelText('카드 보드')).toBeNull();
  await act(async () => useUIStore.getState().setMainPaneView('folder-1', 'board'));
  await waitFor(() => expect(screen.getByTestId('postit-card-draft')).toBeTruthy());
});

beforeEach(() => {
  useUIStore.setState({ mainPaneViews: { global: 'board' }, floatingComposerBottomInset: 0, selectedCardId: null, folderOverlayVisible: false });
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
  expect(screen.getByLabelText('완료·취소 숨김').props.accessibilityState.selected).toBe(true);
  await act(async () => fireEvent.press(screen.getByLabelText('완료·취소 숨김')));
  await waitFor(()=>expect(screen.getByTestId('postit-card-card-1')).toBeTruthy());
  expect(screen.queryByLabelText('데일리 기록')).toBeNull();
  expect(screen.queryByLabelText('기존 데일리 기록')).toBeNull();
  expect(screen.queryByLabelText('카드 보드')).toBeNull();
  expect(screen.getByLabelText('보드 확대')).toBeTruthy();
  expect(screen.getAllByLabelText('드래프트 카드 추가')).toHaveLength(1);
  await act(async () => fireEvent.press(screen.getByLabelText('드래프트 카드 추가')));
  expect(screen.getByLabelText('카드 제목')).toBeTruthy();

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
  await act(async () => fireEvent.press(screen.getByLabelText('완료·취소 숨김')));
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
  await act(async () => fireEvent.press(screen.getByLabelText('완료·취소 숨김')));
  await waitFor(()=>expect(screen.getByText(/최신 보고 원문/)).toBeTruthy());
});

test('폴더 탭은 요청한 검색창과 기존 본문을 유지한다', () => {
  useUIStore.setState({ activeSection: { kind: 'project', folderId: 'folder-1', projectPageId: 'page-1' } });
  const screen = render(<MainListPane showSearch />);
  expect(screen.UNSAFE_getByType(require('../../search/SessionSearchField').SessionSearchField)).toBeTruthy();
  expect(screen.getByTestId('folder-existing')).toBeTruthy();
  expect(screen.queryByLabelText('보드 확대')).toBeNull();
});

test('좁은 목록 패널은 보드 액션을 오버플로 메뉴로 접는다', async () => {
  useUIStore.setState({ activeSection: { kind: 'daily', date: '2026-10-01' } });
  const screen = render(<MainListPane paneWidth={333} />);
  await waitFor(() => expect(screen.getByTestId('postit-card-draft')).toBeTruthy());

  expect(screen.getByTestId('board-header-overflow-button')).toBeTruthy();
  expect(screen.queryByLabelText('보드 확대')).toBeNull();
  expect(screen.queryByLabelText('드래프트 카드 추가')).toBeNull();

  fireEvent.press(screen.getByTestId('board-header-overflow-button'));
  expect(screen.getByTestId('board-header-overflow-menu')).toBeTruthy();
  expect(screen.getByTestId('board-header-overflow-create')).toBeTruthy();
  expect(screen.getByTestId('board-header-overflow-hide-done')).toBeTruthy();
  expect(screen.getByTestId('board-header-overflow-expand')).toBeTruthy();

  fireEvent.press(screen.getByTestId('board-header-overflow-hide-done'));
  expect(screen.queryByTestId('board-header-overflow-menu')).toBeNull();
  await waitFor(() => expect(Object.values(useSettingsStore.getState().cardIncludeCompleted)).toContain(true));
});

test('넓은 목록 패널은 기존 보드 액션을 그대로 노출한다', async () => {
  useUIStore.setState({ activeSection: { kind: 'daily', date: '2026-10-01' } });
  const screen = render(<MainListPane paneWidth={480} />);
  await waitFor(() => expect(screen.getByTestId('postit-card-draft')).toBeTruthy());
  expect(screen.getByLabelText('보드 확대')).toBeTruthy();
  expect(screen.queryByTestId('board-header-overflow-button')).toBeNull();
});

test('세로 목록 칸 보드 머리는 폴더 이름과 보드 단추 셋을 한 줄에 두고 머리에는 보드 단추가 없다', async () => {
  useSessionStore.setState({
    catalog: { folders: [{ id: 'folder-1', name: '공개 예시 폴더 01' }], sessions: {} } as never,
  });
  useUIStore.setState({ activeSection: { kind: 'project', folderId: 'folder-1', projectPageId: 'page-1' }, mainPaneViews: {} });
  const screen = render(<MainListPane showSearch paneWidth={456} />);
  expect(screen.UNSAFE_getByType(require('../../search/SessionSearchField').SessionSearchField)).toBeTruthy();
  expect(screen.getByLabelText('기존 보기')).toBeTruthy();
  expect(screen.getByLabelText('카드 보드')).toBeTruthy();

  await act(async () => fireEvent.press(screen.getByLabelText('카드 보드')));
  await waitFor(() => expect(screen.getByTestId('postit-card-draft')).toBeTruthy());
  const header = within(screen.getByTestId('tablet-main-header'));
  expect(header.queryByTestId('board-header-overflow-button')).toBeNull();
  expect(header.queryByLabelText('보드 메뉴')).toBeNull();
  for (const label of ['드래프트 카드 추가', '완료·취소 숨김', '보드 확대']) {
    expect(header.queryByLabelText(label)).toBeNull();
  }
  expect(screen.getByLabelText('기존 보기')).toBeTruthy();

  expect(screen.getByText('공개 예시 폴더 01')).toBeTruthy();
  expect(screen.getAllByLabelText('드래프트 카드 추가')).toHaveLength(1);
  expect(screen.getAllByLabelText('완료·취소 숨김')).toHaveLength(1);
  expect(screen.getAllByLabelText('보드 확대')).toHaveLength(1);

  expect(screen.getByTestId('completed-cards-toggle-on')).toBeTruthy();
  await act(async () => fireEvent.press(screen.getByLabelText('완료·취소 숨김')));
  await waitFor(() => expect(screen.getByTestId('completed-cards-toggle-off')).toBeTruthy());

  await act(async () => fireEvent.press(screen.getByLabelText('드래프트 카드 추가')));
  expect(screen.getByLabelText('카드 제목')).toBeTruthy();
  await act(async () => fireEvent.press(screen.getByLabelText('보드 확대')));
  expect(screen.getByTestId('card-board-expanded')).toBeTruthy();
});
