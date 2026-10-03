jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));
jest.mock('react-native-gesture-handler', () => ({ ...jest.requireActual('react-native-gesture-handler'), GestureHandlerRootView: require('react-native').View }));
jest.mock('../../../theme', () => ({ ...jest.requireActual('../../../theme'), useDeviceType: () => mockDevice }));
jest.mock('../../../hooks/useCardList', () => ({ useCardList: () => ({ cards: mockCards, loading: mockLoading, error: null, refresh: jest.fn() }) }));
jest.mock('../../../hooks/useCompletedCards',()=>({useCompletedCards:(_api:unknown,_folder:unknown,shown:boolean)=>({cards:shown?mockCards.filter(card=>card.status==='done'):[],period:'7',start:'2026-10-01',end:'2026-10-02',search:'',setPeriod:jest.fn(),setStart:jest.fn(),setEnd:jest.fn(),setSearch:jest.fn(),loadMore:jest.fn(),resetKey:'fixture',loading:false,error:null})}));
import React, { useState } from 'react';
import { act, fireEvent, render, within } from '@testing-library/react-native';
import { ActivityIndicator, StyleSheet } from 'react-native';
import { CardBoardWorkspace } from '../CardBoardWorkspace';
import { AppModalSurface } from '../../AppModalSurface';
import { cardFixture } from '../../../test-support/cards';
import { useUIStore } from '../../../store/uiStore';
jest.mock('../FolderWorkspaceReadOverlay', () => ({ FolderWorkspaceReadOverlay: () => require('react').createElement(require('react-native').View, { testID: 'board-detail-host' }) }));

let mockCards = [cardFixture({ id: 'done', status: 'done' }), cardFixture({ id: 'todo' })];
let mockDevice = 'tablet';
let mockLoading = false;
beforeEach(() => { mockDevice = 'tablet'; mockLoading = false; });
test('tablet panel uses phone lanes and inset, while expanded board keeps wide geometry and resets inset', () => {
  const ref = React.createRef<import('../CardBoardWorkspace').CardBoardWorkspaceHandle>();
  const screen = render(<CardBoardWorkspace ref={ref} api={null} bottomInset={120} cardDisplay={{ includeCompleted: true, onChange: jest.fn() }} onOpen={() => {}} />);
  expect(screen.getByTestId('card-board-stages')).toBeTruthy();
  expect(StyleSheet.flatten(screen.getByTestId('card-board-workspace').props.style).paddingHorizontal).toBe(0);
  const scroll = screen.getByTestId('card-board-scroll-review');
  expect(StyleSheet.flatten(scroll.props.contentContainerStyle).paddingBottom).toBe(136);
  expect(StyleSheet.flatten(screen.getByTestId('card-board-scroll-done').props.contentContainerStyle).paddingBottom).toBe(136);
  fireEvent.press(screen.getByLabelText('실행 중 레인 보기'));
  act(() => ref.current!.openExpanded());
  const expanded = within(screen.getByTestId('card-board-expanded'));
  expect(expanded.queryByTestId('card-board-stages')).toBeNull();
  expect(StyleSheet.flatten(expanded.getByTestId('card-board-scroll-review').props.contentContainerStyle).paddingBottom).toBe(16);
});
function Sample({ folderId }: { folderId?: string }) {
  const [includeCompleted, onChange] = useState(false);
  return <CardBoardWorkspace api={null} folderId={folderId} cardDisplay={{ includeCompleted, onChange }} onOpen={() => {}} />;
}

test.each([
  { device: 'phone', externalHeader: true, expanded: false },
  { device: 'phone', externalHeader: false, expanded: false },
  { device: 'tablet', externalHeader: false, expanded: false },
  { device: 'tablet', externalHeader: true, expanded: false },
  { device: 'tablet', externalHeader: false, expanded: true },
])('자동 갱신 $device external=$externalHeader expanded=$expanded는 보드를 유지하고 구석에만 표시한다', ({ device, externalHeader, expanded }) => {
  mockDevice = device;
  mockCards = [cardFixture({ id: 'todo' })];
  const ref = React.createRef<import('../CardBoardWorkspace').CardBoardWorkspaceHandle>();
  const props = { api: null, externalHeader, cardDisplay: { includeCompleted: false, onChange: jest.fn() }, onOpen: jest.fn() };
  const screen = render(<CardBoardWorkspace ref={ref} {...props} />);
  if (expanded) act(() => ref.current!.openExpanded());
  const host = expanded ? within(screen.getByTestId('card-board-expanded')) : screen;
  const board = host.getByTestId('card-board');
  fireEvent.scroll(board, { nativeEvent: { contentOffset: { x: 140, y: 0 } } });
  const parent = board.parent;
  const frameStyle = StyleSheet.flatten(host.getByTestId('card-board-frame').props.style);
  mockLoading = true;
  screen.rerender(<CardBoardWorkspace ref={ref} {...props} />);
  const spinner = host.getByLabelText('자동 갱신 중');
  expect(StyleSheet.flatten(spinner.props.style).position).toBe('absolute');
  expect(spinner.props.pointerEvents).toBe('none');
  expect(spinner.props.accessibilityRole).toBe('progressbar');
  expect(host.getByTestId('card-board')).toBe(board);
  expect(board.parent).toBe(parent);
  expect(StyleSheet.flatten(host.getByTestId('card-board-frame').props.style)).toEqual(frameStyle);
  for (const indicator of screen.UNSAFE_getAllByType(ActivityIndicator)) {
    expect(StyleSheet.flatten(indicator.props.style).position).toBe('absolute');
  }
  mockLoading = false;
  screen.rerender(<CardBoardWorkspace ref={ref} {...props} />);
  expect(host.queryByLabelText('자동 갱신 중')).toBeNull();
  expect(host.getByTestId('card-board')).toBe(board);
});

test.each([undefined, 'folder-1'])('전체/폴더 %s: 기본 완료 숨김은 완료 레인을 제외하고 상단 원형 액션으로 해제한다', (folderId) => {
  mockCards = [cardFixture({ id: 'done', status: 'done' }), cardFixture({ id: 'todo' })];
  const screen = render(<Sample folderId={folderId} />);
  expect(screen.getByLabelText('완료 숨김').props.accessibilityState.selected).toBe(true);
  expect(screen.queryByTestId('postit-card-done')).toBeNull();
  expect(screen.getByTestId('postit-card-todo')).toBeTruthy();
  expect(screen.getAllByTestId(/^card-board-column-/)).toHaveLength(5);
  expect(screen.queryByTestId('card-board-column-done')).toBeNull();
  fireEvent.press(screen.getByLabelText('완료 숨김'));
  expect(screen.getByTestId('postit-card-done')).toBeTruthy();
  expect(screen.getAllByTestId(/^card-board-column-/)).toHaveLength(6);
  expect(screen.getByLabelText('완료 숨김').props.accessibilityState.selected).toBe(false);
  fireEvent.press(screen.getByLabelText('완료 숨김'));
  fireEvent.press(screen.getByLabelText('완료 숨김'));
  expect(screen.getByTestId('postit-card-done')).toBeTruthy();
});

test('phone expanded selection dismisses the native sheet before its existing detail route', () => {
  mockDevice = 'phone'; mockCards = [cardFixture({ id: 'todo' })];
  const ref = React.createRef<import('../CardBoardWorkspace').CardBoardWorkspaceHandle>(), open = jest.fn();
  const screen = render(<CardBoardWorkspace ref={ref} api={null} cardDisplay={{ includeCompleted: false, onChange: jest.fn() }} onOpen={open} />);
  act(() => ref.current!.openExpanded());
  fireEvent.press(within(screen.getByTestId('card-board-expanded')).getByLabelText('카드 제목 카드 상세'));
  expect(screen.queryByTestId('card-board-expanded')).toBeNull();
  expect(open).toHaveBeenCalledWith('todo');
});

test.each([{ cards: [] }, { cards: [cardFixture({ id: 'done', status: 'done' })] }])('완료 0개/전부 완료에서도 상단 옵션으로 해제한다', ({ cards }) => {
  mockCards = cards;
  const screen = render(<Sample />);
  expect(screen.getByLabelText('완료 숨김').props.accessibilityState.selected).toBe(true);
  fireEvent.press(screen.getByLabelText('완료 숨김'));
  expect(screen.getByLabelText('완료 숨김').props.accessibilityState.selected).toBe(false);
  if (cards.length) expect(screen.getByTestId('postit-card-done')).toBeTruthy();
});

test('expanded tablet keeps the mounted board and its position underneath detail, then releases its host on unmount', () => {
  mockCards = [cardFixture({ id: 'todo' })];
  const ref = React.createRef<import('../CardBoardWorkspace').CardBoardWorkspaceHandle>();
  const screen = render(<CardBoardWorkspace ref={ref} api={null} folderId="folder-1" cardDisplay={{ includeCompleted: false, onChange: jest.fn() }} onOpen={id => useUIStore.getState().openCardOverlay(id)} />);
  act(() => ref.current!.openExpanded());
  const expanded = within(screen.getByTestId('card-board-expanded'));
  const mountedBoard = expanded.getByTestId('card-board');
  fireEvent.scroll(mountedBoard, { nativeEvent: { contentOffset: { x: 140, y: 0 } } });
  fireEvent.press(expanded.getByLabelText('카드 제목 카드 상세'));
  expect(screen.getByTestId('card-board-expanded')).toBeTruthy();
  expect(expanded.getByTestId('board-detail-host')).toBeTruthy();
  act(() => { useUIStore.getState().closeFolderOverlay(); });
  expect(screen.getByTestId('card-board-expanded')).toBeTruthy();
  expect(within(screen.getByTestId('card-board-expanded')).getByTestId('card-board')).toBe(mountedBoard);
  screen.rerender(<CardBoardWorkspace ref={ref} api={null} folderId="folder-2" cardDisplay={{ includeCompleted: false, onChange: jest.fn() }} onOpen={id => useUIStore.getState().openCardOverlay(id)} />);
  expect(screen.queryByTestId('card-board-expanded')).toBeNull();
  expect(useUIStore.getState().cardBoardExpanded).toBe(false);
  act(() => ref.current!.openExpanded());
  screen.unmount();
  expect(useUIStore.getState().cardBoardExpanded).toBe(false);
});

test.each(['phone', 'tablet'])('확대 닫힘 %s은 선택적 콜백을 한 번 호출하고 공개 handle로 다시 열린다', device => {
  mockDevice = device;
  mockCards = [cardFixture({ id: 'todo' })];
  const ref = React.createRef<import('../CardBoardWorkspace').CardBoardWorkspaceHandle>();
  const closed = jest.fn();
  const screen = render(<CardBoardWorkspace ref={ref} api={null}
    cardDisplay={{ includeCompleted: false, onChange: jest.fn() }} onOpen={jest.fn()} onExpandedClose={closed} />);
  act(() => ref.current!.openExpanded());
  fireEvent(screen.UNSAFE_getByType(AppModalSurface), 'requestClose');
  expect(screen.queryByTestId('card-board-expanded')).toBeNull();
  expect(closed).toHaveBeenCalledTimes(1);
  act(() => ref.current!.openExpanded());
  expect(screen.getByTestId('card-board-expanded')).toBeTruthy();
  if (device === 'tablet') fireEvent.press(within(screen.getByTestId('card-board-expanded')).getByLabelText('보드 확대 닫기'));
  else fireEvent.press(within(screen.getByTestId('card-board-expanded')).getByLabelText('카드 제목 카드 상세'));
  expect(closed).toHaveBeenCalledTimes(2);
});
