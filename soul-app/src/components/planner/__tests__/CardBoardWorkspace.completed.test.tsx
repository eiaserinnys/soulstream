jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));
jest.mock('react-native-gesture-handler', () => ({ ...jest.requireActual('react-native-gesture-handler'), GestureHandlerRootView: require('react-native').View }));
jest.mock('../../../theme', () => ({ ...jest.requireActual('../../../theme'), useDeviceType: () => mockDevice }));
jest.mock('../../../hooks/useCardList', () => ({ useCardList: () => ({ cards: mockCards, loading: false, error: null, refresh: jest.fn() }) }));
import React, { useState } from 'react';
import { act, fireEvent, render, within } from '@testing-library/react-native';
import { CardBoardWorkspace } from '../CardBoardWorkspace';
import { cardFixture } from '../../../test-support/cards';
import { useUIStore } from '../../../store/uiStore';
jest.mock('../FolderWorkspaceReadOverlay', () => ({ FolderWorkspaceReadOverlay: () => require('react').createElement(require('react-native').View, { testID: 'board-detail-host' }) }));

let mockCards = [cardFixture({ id: 'done', status: 'done' }), cardFixture({ id: 'todo' })];
let mockDevice = 'tablet';
beforeEach(() => { mockDevice = 'tablet'; });
function Sample({ folderId }: { folderId?: string }) {
  const [includeCompleted, onChange] = useState(false);
  return <CardBoardWorkspace api={null} folderId={folderId} cardDisplay={{ includeCompleted, onChange }} onOpen={() => {}} />;
}

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
