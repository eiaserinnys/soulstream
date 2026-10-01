jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));
import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { CardBoard } from '../CardBoard';
import { cardFixture } from '../../../test-support/cards';

test('phone initially shows review even empty, snaps by lane and preserves position across rerenders', () => {
  const saved = jest.fn();
  const screen = render(<CardBoard phone api={null} cards={[]} onOpen={() => {}} onPositionChange={saved} />);
  fireEvent(screen.getByTestId('card-board-frame'), 'layout', { nativeEvent: { layout: { width: 390, height: 600 } } });
  const board = screen.getByTestId('card-board');
  expect(board.props.snapToOffsets[0]).toBe(0);
  expect(saved.mock.calls.at(-1)[0].x).toBe(board.props.snapToOffsets[4]);
  expect(screen.getByTestId('card-board-lane-heading-review').props.children).toEqual(expect.arrayContaining(['검수 대기 ', expect.anything()]));
  expect(StyleSheet.flatten(screen.getByTestId('card-board-column-review').props.style).width).toBeLessThan(390);
  fireEvent.scroll(board, { nativeEvent: { contentOffset: { x: 0, y: 0 } } });
  screen.rerender(<CardBoard phone api={null} cards={[cardFixture()]} onOpen={() => {}} />);
  expect(screen.getByTestId('card-board').props.contentOffset.x).toBe(board.props.contentOffset.x);
  const paper = screen.getByTestId('postit-card-card-1').props.style;
  expect(paper.width / paper.height).toBeCloseTo(320 / 280);
  expect(paper.width).toBeLessThan(StyleSheet.flatten(screen.getByTestId('card-board-column-todo').props.style).width);
});

test('숨김 토글은 중간 선택 레인을 유지하고 완료 선택만 검수 대기로 되돌린다', () => {
  const saved = jest.fn();
  const screen = render(<CardBoard phone api={null} cards={[]} includeCompleted onOpen={() => {}} onPositionChange={saved} />);
  fireEvent(screen.getByTestId('card-board-frame'), 'layout', { nativeEvent: { layout: { width: 390, height: 600 } } });
  fireEvent.press(screen.getByLabelText('실행 중 레인 보기'));
  screen.rerender(<CardBoard phone api={null} cards={[]} includeCompleted={false} onOpen={() => {}} onPositionChange={saved} />);
  expect(saved.mock.calls.at(-1)[0].lane).toBe('running');
  expect(screen.queryByLabelText('완료 레인 보기')).toBeNull();
  screen.rerender(<CardBoard phone api={null} cards={[]} includeCompleted onOpen={() => {}} onPositionChange={saved} />);
  fireEvent.press(screen.getByLabelText('완료 레인 보기'));
  screen.rerender(<CardBoard phone api={null} cards={[]} includeCompleted={false} onOpen={() => {}} onPositionChange={saved} />);
  expect(saved.mock.calls.at(-1)[0].lane).toBe('review');
  expect(saved.mock.calls.at(-1)[0].x).toBe(screen.getByTestId('card-board').props.snapToOffsets[4]);
});
