jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));
import React from 'react';
import { Alert, StyleSheet } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { CardBoard } from '../CardBoard';
import { BoardDragCard } from '../BoardDragCard';
import { cardFixture } from '../../../test-support/cards';

const cards = (['todo', 'queued', 'running', 'blocked', 'review', 'on_hold'] as const)
  .map((status) => cardFixture({ id: status, status }));

test('레일 폭만큼 뷰포트를 줄여 스냅과 좌우 여백이 좁은 화면 값과 같다', () => {
  const narrow = render(<CardBoard phone api={null} cards={cards} includeCompleted={false} onOpen={() => {}} />);
  fireEvent(narrow.getByTestId('card-board-frame'), 'layout', { nativeEvent: { layout: { width: 382, height: 600 } } });
  const expected = narrow.getByTestId('card-board').props.snapToOffsets;
  expect(expected.length).toBeGreaterThan(1);

  const wide = render(<CardBoard phone railOverlayWidth={84} api={null} cards={cards} includeCompleted={false} onOpen={() => {}} />);
  fireEvent(wide.getByTestId('card-board-frame'), 'layout', { nativeEvent: { layout: { width: 466, height: 600 } } });
  const board = wide.getByTestId('card-board');
  expect(board.props.snapToOffsets).toEqual(expected);
  const content = StyleSheet.flatten(board.props.contentContainerStyle);
  expect(content.paddingLeft).toBe(8);
  expect(content.paddingRight).toBe(92);
});

test('사이드바 폭 위에서 놓으면 프레임 밖으로 판정해 이동을 취소한다', () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const api = { executeCard: jest.fn(), setCardStatus: jest.fn(), getCard: jest.fn() } as never;
  const screen = render(<CardBoard phone railOverlayWidth={84} api={api} cards={cards} includeCompleted={false} onOpen={() => {}} />);
  fireEvent(screen.getByTestId('card-board-frame'), 'layout', { nativeEvent: { layout: { width: 466, height: 600 } } });
  const source = screen.UNSAFE_getAllByType(BoardDragCard).find((node) => node.props.card.id === 'todo')!;

  source.props.onDrop({ absoluteX: 426, absoluteY: 200, x: 0, y: 0 });

  expect(alert).toHaveBeenCalledWith('카드 이동 취소', expect.any(String));
  expect((api as { executeCard: jest.Mock }).executeCard).not.toHaveBeenCalled();
  expect((api as { setCardStatus: jest.Mock }).setCardStatus).not.toHaveBeenCalled();
  alert.mockRestore();
});
