jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { State } from 'react-native-gesture-handler';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';
import { BoardDragCard } from '../BoardDragCard';
import { cardFixture } from '../../../test-support/cards';

function sample() {
  const callbacks = { onOpen: jest.fn(), onMenu: jest.fn(), onStart: jest.fn(), onMove: jest.fn(), onDrop: jest.fn(), onFinish: jest.fn() };
  const screen = render(<BoardDragCard api={{} as any} card={cardFixture()} dragging={false} {...callbacks} />);
  return { screen, callbacks, gesture: getByGestureTestId('board-drag-card-1') };
}
test('longpress move drops once; stationary release opens only menu; leftover press is suppressed', () => {
  const { screen, callbacks, gesture } = sample();
  act(() => fireGestureHandler(gesture, [{ state: State.BEGAN }, { state: State.ACTIVE },
    { translationX: 70, translationY: 0 }, { state: State.END, translationX: 70, translationY: 0 }]));
  expect(callbacks.onDrop).toHaveBeenCalledTimes(1);
  expect(callbacks.onMenu).not.toHaveBeenCalled();
  fireEvent.press(screen.getByLabelText('카드 제목 카드 상세'));
  expect(callbacks.onOpen).not.toHaveBeenCalled();
  expect(callbacks.onFinish).toHaveBeenCalledTimes(1);
});
test('stationary longpress and cancellation do not trigger drag and menu together', () => {
  const { callbacks, gesture } = sample();
  act(() => fireGestureHandler(gesture, [{ state: State.BEGAN }, { state: State.ACTIVE }, { state: State.END, translationX: 0, translationY: 0 }]));
  expect(callbacks.onMenu).toHaveBeenCalledTimes(1);
  expect(callbacks.onDrop).not.toHaveBeenCalled();
  callbacks.onMenu.mockClear();
  act(() => fireGestureHandler(gesture, [{ state: State.BEGAN }, { state: State.ACTIVE }, { state: State.CANCELLED, translationX: 50 }]));
  expect(callbacks.onMenu).not.toHaveBeenCalled();
  expect(callbacks.onDrop).not.toHaveBeenCalled();
});
test('scroll before activation never calls finish/snap or menu', () => {
  const { callbacks, gesture } = sample();
  // RNGH's sequence helper inserts ACTIVE before terminal events. A native
  // pre-activation scroll failure has no ACTIVE; deliver that final callback directly.
  act(() => gesture.handlers.onFinalize?.({ state: State.FAILED, translationX: 40 } as any, false));
  expect(callbacks.onMenu).not.toHaveBeenCalled();
  expect(callbacks.onFinish).not.toHaveBeenCalled();
});

test('secondary pointer opens once and blocks following primary/longpress/drag; cancel recovers', () => {
  const { screen, callbacks, gesture } = sample();
  const target = screen.getByTestId('board-card-gesture-card-1');
  fireEvent(target, 'pointerDown', { nativeEvent: { button: 2 } });
  fireEvent(target, 'pointerDown', { nativeEvent: { button: 2 } });
  act(() => fireGestureHandler(gesture, [{ state: State.BEGAN }, { state: State.ACTIVE },
    { state: State.END, translationX: 80 }]));
  fireEvent.press(screen.getByLabelText('카드 제목 카드 상세'));
  expect(callbacks.onMenu).toHaveBeenCalledTimes(1);
  expect(callbacks.onStart).not.toHaveBeenCalled();
  expect(callbacks.onDrop).not.toHaveBeenCalled();
  expect(callbacks.onOpen).not.toHaveBeenCalled();
  fireEvent(target, 'pointerCancel', { nativeEvent: {} });
  const now = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000);
  fireEvent.press(screen.getByLabelText('카드 제목 카드 상세'));
  expect(callbacks.onOpen).toHaveBeenCalledTimes(1);
  now.mockRestore();
});
