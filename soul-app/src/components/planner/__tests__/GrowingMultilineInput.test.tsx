import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import type { ScrollView } from 'react-native';
import { GrowingMultilineInput } from '../GrowingMultilineInput';

afterEach(() => {
  jest.restoreAllMocks();
});

test('네 줄부터 여덟 줄 contentSize를 최소·최대 사이의 실제 높이로 투영한다', () => {
  const { screen } = renderInput('한 줄\n두 줄\n세 줄\n네 줄\n다섯 줄\n여섯 줄\n일곱 줄\n여덟 줄');
  const input = screen.getByTestId('growing-input');

  expect(style(input.props.style)).toMatchObject({
    minHeight: 112,
    maxHeight: 224,
    height: 112,
    paddingVertical: 8,
    paddingHorizontal: 0,
  });
  expect(input.props.scrollEnabled).toBe(false);

  fireContentSizeChange(input, 120);
  expect(style(screen.getByTestId('growing-input').props.style).height).toBe(120);

  fireContentSizeChange(screen.getByTestId('growing-input'), 176);
  expect(style(screen.getByTestId('growing-input').props.style).height).toBe(176);

  fireContentSizeChange(screen.getByTestId('growing-input'), 260);
  expect(style(screen.getByTestId('growing-input').props.style).height).toBe(224);
});

test('최대 높이 반영 뒤 다음 frame에 바깥을 정렬하고 TextInput으로 caret 스크롤을 넘긴다', () => {
  const frames = mockAnimationFrames();
  const { screen, scrollToEnd } = renderInput('긴 입력\n'.repeat(20));
  const input = screen.getByTestId('growing-input');

  fireEvent(input, 'focus');
  scrollToEnd.mockClear();

  fireContentSizeChange(input, 240);
  const capped = screen.getByTestId('growing-input');
  expect(style(capped.props.style).height).toBe(224);
  expect(capped.props.scrollEnabled).toBe(true);
  expect(scrollToEnd).not.toHaveBeenCalled();
  expect(frames.pendingCount()).toBe(1);

  frames.flushNext();
  expect(scrollToEnd).toHaveBeenCalledTimes(1);
  scrollToEnd.mockClear();
  fireEvent(capped, 'selectionChange', {
    nativeEvent: { selection: { start: 80, end: 80 } },
  });
  expect(scrollToEnd).not.toHaveBeenCalled();
  expect(frames.pendingCount()).toBe(0);
});

test('연속 높이 변화는 하나의 frame으로 합쳐 마지막 렌더 높이 뒤 한 번만 정렬한다', () => {
  const frames = mockAnimationFrames();
  const { screen, scrollToEnd } = renderInput('긴 입력\n'.repeat(20));

  fireEvent(screen.getByTestId('growing-input'), 'focus');
  scrollToEnd.mockClear();
  fireContentSizeChange(screen.getByTestId('growing-input'), 120);
  fireContentSizeChange(screen.getByTestId('growing-input'), 176);
  fireContentSizeChange(screen.getByTestId('growing-input'), 240);

  expect(style(screen.getByTestId('growing-input').props.style).height).toBe(224);
  expect(scrollToEnd).not.toHaveBeenCalled();
  expect(frames.pendingCount()).toBe(1);

  frames.flushNext();
  expect(scrollToEnd).toHaveBeenCalledTimes(1);
  expect(frames.pendingCount()).toBe(0);
});

test('contentSizeChange 뒤 연속 selectionChange를 같은 외곽 정렬 frame 하나로 합친다', () => {
  const frames = mockAnimationFrames();
  const { screen, scrollToEnd } = renderInput('긴 입력\n'.repeat(8));

  fireEvent(screen.getByTestId('growing-input'), 'focus');
  scrollToEnd.mockClear();
  fireContentSizeChange(screen.getByTestId('growing-input'), 176);
  fireEvent(screen.getByTestId('growing-input'), 'selectionChange', {
    nativeEvent: { selection: { start: 10, end: 10 } },
  });
  fireEvent(screen.getByTestId('growing-input'), 'selectionChange', {
    nativeEvent: { selection: { start: 20, end: 20 } },
  });

  expect(scrollToEnd).not.toHaveBeenCalled();
  expect(frames.pendingCount()).toBe(1);

  frames.flushNext();
  expect(scrollToEnd).toHaveBeenCalledTimes(1);
  expect(frames.pendingCount()).toBe(0);
});

test('blur와 unmount는 높이 반영 뒤 예약한 바깥 정렬 frame을 취소한다', () => {
  const frames = mockAnimationFrames();
  const blurred = renderInput('긴 입력\n'.repeat(8));

  fireEvent(blurred.screen.getByTestId('growing-input'), 'focus');
  blurred.scrollToEnd.mockClear();
  fireContentSizeChange(blurred.screen.getByTestId('growing-input'), 176);
  expect(frames.pendingCount()).toBe(1);

  fireEvent(blurred.screen.getByTestId('growing-input'), 'blur');
  expect(frames.pendingCount()).toBe(0);
  expect(blurred.scrollToEnd).not.toHaveBeenCalled();
  blurred.unmount();

  const unmounted = renderInput('긴 입력\n'.repeat(8));
  fireEvent(unmounted.screen.getByTestId('growing-input'), 'focus');
  unmounted.scrollToEnd.mockClear();
  fireContentSizeChange(unmounted.screen.getByTestId('growing-input'), 176);
  expect(frames.pendingCount()).toBe(1);

  unmounted.unmount();
  expect(frames.pendingCount()).toBe(0);
  expect(unmounted.scrollToEnd).not.toHaveBeenCalled();
});

test('실제 value 삭제 뒤에는 입력 높이를 줄인다', () => {
  const initialValue = '긴 입력\n'.repeat(8);
  const nextValue = '짧은 입력';
  const { screen, rerender } = renderInput(initialValue);

  fireContentSizeChange(screen.getByTestId('growing-input'), 176);
  expect(style(screen.getByTestId('growing-input').props.style).height).toBe(176);

  rerender(nextValue);
  fireContentSizeChange(screen.getByTestId('growing-input'), 40);

  expect(style(screen.getByTestId('growing-input').props.style)).toMatchObject({
    height: 112,
  });
  expect(screen.getByTestId('growing-input').props.scrollEnabled).toBe(false);
});

test('같은 value의 교차하는 iOS 축소 재측정은 높이를 되돌리지 않는다', () => {
  const { screen } = renderInput('같은 값\n'.repeat(6));

  fireContentSizeChange(screen.getByTestId('growing-input'), 144);
  expect(style(screen.getByTestId('growing-input').props.style).height).toBe(144);

  fireContentSizeChange(screen.getByTestId('growing-input'), 112);
  expect(style(screen.getByTestId('growing-input').props.style).height).toBe(144);

  fireContentSizeChange(screen.getByTestId('growing-input'), 145);
  expect(style(screen.getByTestId('growing-input').props.style).height).toBe(145);

  fireContentSizeChange(screen.getByTestId('growing-input'), 111);
  expect(style(screen.getByTestId('growing-input').props.style).height).toBe(145);
});

function renderInput(initialValue: string) {
  const scrollToEnd = jest.fn();
  const outerScrollRef = {
    current: { scrollToEnd },
  } as unknown as React.RefObject<ScrollView>;
  const onChangeText = jest.fn();
  const renderResult = render(<GrowingMultilineInput
    testID="growing-input"
    value={initialValue}
    onChangeText={onChangeText}
    outerScrollRef={outerScrollRef}
    minHeight={112}
    maxHeight={224}
    verticalPadding={8}
  />);

  return {
    screen: renderResult,
    scrollToEnd,
    unmount: renderResult.unmount,
    rerender(value: string) {
      renderResult.rerender(<GrowingMultilineInput
        testID="growing-input"
        value={value}
        onChangeText={onChangeText}
        outerScrollRef={outerScrollRef}
        minHeight={112}
        maxHeight={224}
        verticalPadding={8}
      />);
    },
  };
}

function fireContentSizeChange(input: ReturnType<typeof render>['root'], height: number) {
  fireEvent(input, 'contentSizeChange', {
    nativeEvent: { contentSize: { width: 320, height } },
  });
}

function mockAnimationFrames() {
  const scheduledFrames = new Map<number, FrameRequestCallback>();
  let nextFrameId = 1;
  jest.spyOn(global, 'requestAnimationFrame').mockImplementation((callback) => {
    const frameId = nextFrameId;
    nextFrameId += 1;
    scheduledFrames.set(frameId, callback);
    return frameId;
  });
  jest.spyOn(global, 'cancelAnimationFrame').mockImplementation((frameId) => {
    if (typeof frameId === 'number') scheduledFrames.delete(frameId);
  });

  return {
    pendingCount: () => scheduledFrames.size,
    flushNext() {
      const next = scheduledFrames.entries().next().value as
        | [number, FrameRequestCallback]
        | undefined;
      if (!next) throw new Error('예약된 animation frame이 없습니다.');
      const [frameId, callback] = next;
      scheduledFrames.delete(frameId);
      act(() => callback(0));
    },
  };
}

function style(value: unknown) {
  return require('react-native').StyleSheet.flatten(value) as Record<string, unknown>;
}
