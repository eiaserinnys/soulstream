import React from 'react';
import {
  AppState,
  Keyboard,
  StyleSheet,
  View,
  type KeyboardEvent,
  type KeyboardEventName,
} from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import {
  AppKeyboardAvoidingView,
  resolveKeyboardOverlap,
} from '../AppKeyboardAvoidingView';

const keyboardListeners = new Map<
  KeyboardEventName,
  Set<(event: KeyboardEvent) => void>
>();
let keyboardVisible = false;
let keyboardMetrics: ReturnType<typeof Keyboard.metrics>;
type MeasureInWindowCallback = (
  x: number,
  y: number,
  width: number,
  height: number,
) => void;
const viewPrototype = (
  View as unknown as {
    prototype: {
      measureInWindow: (callback: MeasureInWindowCallback) => void;
    };
  }
).prototype;

function emitKeyboard(name: KeyboardEventName, event: KeyboardEvent) {
  for (const listener of keyboardListeners.get(name) ?? []) {
    listener(event);
  }
}

function fireAppState(state: 'active' | 'background' | 'inactive') {
  (AppState as { currentState: string }).currentState = state;
  for (const listener of (globalThis as any).__appStateListeners ?? []) {
    listener(state);
  }
}

function keyboardEvent(
  screenY: number,
  height: number,
  screenX = 0,
  width = 1024,
): KeyboardEvent {
  return {
    duration: 250,
    easing: 'keyboard',
    endCoordinates: {
      screenX,
      screenY,
      width,
      height,
    },
    startCoordinates: {
      screenX,
      screenY: 1366,
      width,
      height,
    },
    isEventFromThisApp: true,
  };
}

function paddingBottom(view: { props: { style?: unknown } }): number {
  const style = StyleSheet.flatten(view.props.style as any) as
    | { paddingBottom?: number }
    | undefined;
  return style?.paddingBottom ?? 0;
}

function renderAvoider(behavior: 'height' | 'padding') {
  return render(
    <AppKeyboardAvoidingView testID="keyboard-avoider" behavior={behavior}>
      <View />
    </AppKeyboardAvoidingView>,
  );
}

describe('AppKeyboardAvoidingView', () => {
  beforeEach(() => {
    keyboardListeners.clear();
    keyboardVisible = false;
    keyboardMetrics = undefined;
    (AppState as { currentState: string }).currentState = 'active';
    jest.spyOn(Keyboard, 'addListener').mockImplementation((name, listener) => {
      const listeners = keyboardListeners.get(name) ?? new Set();
      listeners.add(listener);
      keyboardListeners.set(name, listeners);
      return {
        remove: () => {
          listeners.delete(listener);
        },
      } as unknown as ReturnType<typeof Keyboard.addListener>;
    });
    jest.spyOn(Keyboard, 'scheduleLayoutAnimation').mockImplementation(() => {});
    jest
      .spyOn(Keyboard, 'isVisible')
      .mockImplementation(() => keyboardVisible);
    jest.spyOn(Keyboard, 'metrics').mockImplementation(() => keyboardMetrics);
    jest
      .spyOn(viewPrototype, 'measureInWindow')
      .mockImplementation((callback) => callback(0, 100, 700, 700));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('background → active 사이에 비정상 keyboard frame이 와도 inset을 0으로 복구한다', () => {
    const screen = renderAvoider('padding');
    const avoider = screen.getByTestId('keyboard-avoider');
    fireEvent(avoider, 'layout', {
      nativeEvent: {
        layout: { x: 0, y: 100, width: 700, height: 700 },
      },
    });

    act(() => {
      emitKeyboard('keyboardWillShow', keyboardEvent(1, 1365));
    });
    expect(paddingBottom(avoider)).toBe(700);

    act(() => {
      fireAppState('background');
      emitKeyboard('keyboardWillShow', keyboardEvent(1, 1365));
      fireAppState('active');
    });

    expect(paddingBottom(avoider)).toBe(0);
  });

  test('inactive → active 복귀에서 현재 keyboard metrics로 inset을 복원한다', () => {
    const screen = renderAvoider('padding');
    const avoider = screen.getByTestId('keyboard-avoider');
    fireEvent(avoider, 'layout', {
      nativeEvent: {
        layout: { x: 0, y: 100, width: 700, height: 700 },
      },
    });

    act(() => {
      emitKeyboard('keyboardWillShow', keyboardEvent(500, 300));
    });
    expect(paddingBottom(avoider)).toBe(300);

    keyboardVisible = true;
    keyboardMetrics = keyboardEvent(500, 300).endCoordinates;
    act(() => {
      fireAppState('inactive');
    });
    expect(paddingBottom(avoider)).toBe(0);

    act(() => {
      fireAppState('active');
    });
    expect(Keyboard.metrics).toHaveBeenCalled();
    expect(paddingBottom(avoider)).toBe(300);
  });

  test('background → active 복귀에서 keyboard metrics가 없으면 inset을 0으로 유지한다', () => {
    const screen = renderAvoider('padding');
    const avoider = screen.getByTestId('keyboard-avoider');
    fireEvent(avoider, 'layout', {
      nativeEvent: {
        layout: { x: 0, y: 100, width: 700, height: 700 },
      },
    });

    act(() => {
      emitKeyboard('keyboardWillShow', keyboardEvent(500, 300));
    });
    expect(paddingBottom(avoider)).toBe(300);

    keyboardVisible = true;
    keyboardMetrics = undefined;
    act(() => {
      fireAppState('background');
    });
    expect(paddingBottom(avoider)).toBe(0);

    jest.mocked(Keyboard.metrics).mockClear();
    act(() => {
      fireAppState('active');
    });
    expect(Keyboard.metrics).toHaveBeenCalledTimes(1);
    expect(paddingBottom(avoider)).toBe(0);
  });

  test('정상 keyboard show/hide는 컨테이너와 실제 키보드의 겹침만큼 회피한다', () => {
    const screen = renderAvoider('padding');
    const avoider = screen.getByTestId('keyboard-avoider');
    fireEvent(avoider, 'layout', {
      nativeEvent: {
        layout: { x: 0, y: 100, width: 700, height: 700 },
      },
    });

    act(() => {
      emitKeyboard('keyboardWillShow', keyboardEvent(500, 300));
    });
    expect(paddingBottom(avoider)).toBe(300);

    act(() => {
      emitKeyboard('keyboardWillHide', keyboardEvent(800, 0));
    });
    expect(paddingBottom(avoider)).toBe(0);
  });

  test('height 동작은 정상 키보드에서 원래 높이를 줄이고 hide에서 복구한다', () => {
    const screen = renderAvoider('height');
    const avoider = screen.getByTestId('keyboard-avoider');
    fireEvent(avoider, 'layout', {
      nativeEvent: {
        layout: { x: 0, y: 100, width: 700, height: 700 },
      },
    });

    act(() => {
      emitKeyboard('keyboardWillShow', keyboardEvent(500, 300));
    });
    expect(StyleSheet.flatten(avoider.props.style)).toEqual(
      expect.objectContaining({ height: 400, flex: 0 }),
    );

    act(() => {
      emitKeyboard('keyboardWillHide', keyboardEvent(800, 0));
    });
    expect(StyleSheet.flatten(avoider.props.style)?.height).toBeUndefined();
  });

  test('height 적용 뒤 축소된 frame이 재측정되어도 기존 keyboard inset을 유지한다', () => {
    let measuredHeight = 700;
    jest
      .mocked(viewPrototype.measureInWindow)
      .mockImplementation((callback) => callback(0, 100, 700, measuredHeight));
    const screen = renderAvoider('height');
    const avoider = screen.getByTestId('keyboard-avoider');
    fireEvent(avoider, 'layout', {
      nativeEvent: {
        layout: { x: 0, y: 100, width: 700, height: measuredHeight },
      },
    });

    act(() => {
      emitKeyboard('keyboardWillShow', keyboardEvent(500, 300));
    });
    expect(StyleSheet.flatten(avoider.props.style)).toEqual(
      expect.objectContaining({ height: 400, flex: 0 }),
    );

    measuredHeight = 400;
    act(() => {
      fireEvent(avoider, 'layout', {
        nativeEvent: {
          layout: { x: 0, y: 100, width: 700, height: measuredHeight },
        },
      });
    });

    expect(StyleSheet.flatten(avoider.props.style)).toEqual(
      expect.objectContaining({ height: 400, flex: 0 }),
    );
  });

  test('height show 측정이 비동기로 끝나기 전에 frame이 축소되어도 inset을 잃지 않는다', () => {
    const pendingMeasurements: MeasureInWindowCallback[] = [];
    jest
      .mocked(viewPrototype.measureInWindow)
      .mockImplementation((callback) => pendingMeasurements.push(callback));
    const screen = renderAvoider('height');
    const avoider = screen.getByTestId('keyboard-avoider');
    fireEvent(avoider, 'layout', {
      nativeEvent: {
        layout: { x: 0, y: 100, width: 700, height: 700 },
      },
    });
    act(() => {
      pendingMeasurements.shift()?.(0, 100, 700, 700);
    });

    act(() => {
      emitKeyboard('keyboardWillShow', keyboardEvent(500, 300));
    });
    expect(StyleSheet.flatten(avoider.props.style)).toEqual(
      expect.objectContaining({ height: 400, flex: 0 }),
    );

    act(() => {
      pendingMeasurements.shift()?.(0, 100, 700, 400);
    });

    expect(StyleSheet.flatten(avoider.props.style)).toEqual(
      expect.objectContaining({ height: 400, flex: 0 }),
    );
  });

  test('화면 좌표 측정 전에는 부모 상대 layout 좌표로 inset을 선적용하지 않는다', () => {
    const pendingMeasurements: MeasureInWindowCallback[] = [];
    jest
      .mocked(viewPrototype.measureInWindow)
      .mockImplementation((callback) => pendingMeasurements.push(callback));
    const screen = renderAvoider('padding');
    const avoider = screen.getByTestId('keyboard-avoider');
    fireEvent(avoider, 'layout', {
      nativeEvent: {
        layout: { x: 0, y: 0, width: 700, height: 700 },
      },
    });
    act(() => {
      pendingMeasurements.shift()?.(0, 100, 700, 700);
    });

    fireEvent(avoider, 'layout', {
      nativeEvent: {
        layout: { x: 0, y: 0, width: 700, height: 700 },
      },
    });
    act(() => {
      emitKeyboard('keyboardWillShow', keyboardEvent(500, 300));
    });

    expect(paddingBottom(avoider)).toBe(0);
    act(() => {
      pendingMeasurements.shift()?.(0, 100, 700, 700);
    });
    expect(paddingBottom(avoider)).toBe(300);
  });

  test('다른 앱에서 온 keyboard hide 이벤트는 현재 inset을 지우지 않는다', () => {
    const screen = renderAvoider('padding');
    const avoider = screen.getByTestId('keyboard-avoider');
    fireEvent(avoider, 'layout', {
      nativeEvent: {
        layout: { x: 0, y: 100, width: 700, height: 700 },
      },
    });

    act(() => {
      emitKeyboard('keyboardWillShow', keyboardEvent(500, 300));
    });
    expect(paddingBottom(avoider)).toBe(300);

    act(() => {
      emitKeyboard('keyboardWillHide', {
        ...keyboardEvent(800, 0),
        isEventFromThisApp: false,
      });
    });
    expect(paddingBottom(avoider)).toBe(300);

    act(() => {
      emitKeyboard('keyboardWillHide', keyboardEvent(800, 0));
    });
    expect(paddingBottom(avoider)).toBe(0);
  });

  test('중첩 패널에서는 부모 상대 y가 아니라 화면상 view frame으로 겹침을 계산한다', () => {
    expect(
      resolveKeyboardOverlap(
        { x: 400, y: 100, width: 600, height: 700 },
        { screenX: 0, screenY: 500, width: 1024, height: 300 },
      ),
    ).toBe(300);
    expect(
      resolveKeyboardOverlap(
        { x: 0, y: 100, width: 300, height: 700 },
        { screenX: 400, screenY: 500, width: 600, height: 300 },
      ),
    ).toBe(0);
    expect(
      resolveKeyboardOverlap(
        { x: 0, y: 100, width: 700, height: 700 },
        { screenX: 0, screenY: 0, width: 1024, height: 1366 },
      ),
    ).toBe(0);
  });
});
