import React from 'react';
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
import { fireEvent, render, renderHook } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import type { CardNow, CardNowHistoryEntry } from '../../../api/cardTypes';
import { useTokens } from '../../../theme';
import { CardNowPanel } from '../CardNowPanel';

const now: CardNow = { text: '지금 확인 중입니다.', turn: 'agent', ask: null, updatedAt: '2026-10-05T01:00:00Z', sessionId: 's1' };
const history: CardNowHistoryEntry[] = [
  { text: '지난 확인입니다.', turn: 'user', ask: '이 내용을 봐 주세요.', at: '2026-10-05T00:00:00Z' },
  { text: now.text, turn: now.turn, ask: now.ask, at: now.updatedAt },
];

test('이전·다음은 상황만 넘기고 최신 now 및 확인 항목 상태를 바꾸지 않는다', () => {
  const screen = render(<CardNowPanel now={now} history={history} />);
  fireEvent(screen.getByTestId('card-now-panel'), 'layout', { nativeEvent: { layout: { width: 320, height: 140 } } });
  expect(screen.getByText(now.text)).toBeTruthy();
  fireEvent.press(screen.getByLabelText('이전 상황'));
  expect(screen.getByText('지난 확인입니다.')).toBeTruthy();
  expect(screen.getByTestId('card-now-panel-frame').props.style).toEqual({ height: 140 });
  expect(screen.queryByText('아래 확인 항목은 지금 상태입니다.')).toBeNull();
  expect(screen.getByText('최신으로')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('다음 상황'));
  expect(screen.getByText(now.text)).toBeTruthy();
  expect(screen.getByTestId('card-now-panel-frame').props.style).toBeUndefined();
});

test('상황판 이전·다음 단추의 터치 프레임은 서로 겹치지 않는다', () => {
  const screen = render(<CardNowPanel now={now} history={history} />);
  const tokens = renderHook(() => useTokens()).result.current;
  const previous = StyleSheet.flatten(screen.getByTestId('card-now-previous-arrow').props.style);
  const next = StyleSheet.flatten(screen.getByTestId('card-now-next-arrow').props.style);

  expect(previous.right - next.right).toBe(tokens.hitTarget.min);
  expect(screen.getByTestId('card-now-previous-icon').props.name).toBe('chevron-back');
  expect(screen.getByTestId('card-now-next-icon').props.name).toBe('chevron-forward');
});

test('nowHistory 한 건은 현재 슬롯으로 바꾸어 그려 중복 이전 항목을 만들지 않는다', () => {
  const screen = render(<CardNowPanel now={now} history={[history[1]]} />);
  expect(screen.getAllByText(now.text)).toHaveLength(1);
  expect(screen.queryByLabelText('이전 상황')).toBeNull();
});

test.each([
  ['agent', '에이전트 차례'], ['user', '내 차례'], ['outside', '바깥 대기'],
] as const)('%s 차례의 표기를 보여 준다', (turn, label) => {
  const screen = render(<CardNowPanel now={{ ...now, turn, ask: turn === 'user' ? '확인해 주세요.' : null }} history={[]} />);
  if (turn === 'user') {
    expect(screen.queryByText(label)).toBeNull();
    expect(screen.getByTestId('card-now-turn-band').props.accessibilityLabel).toContain(label);
    expect(screen.getByTestId('card-now-turn-band').props.accessible).toBe(true);
  } else expect(screen.getByText(label)).toBeTruthy();
});

test('모두 확인 띠의 완료는 사용자 조작으로만 실행되고 요청 중에는 눌리지 않는다', () => {
  const onComplete = jest.fn();
  const screen = render(<CardNowPanel now={now} history={[]} allConfirmed onComplete={onComplete} />);
  expect(screen.getByText('모두 확인했습니다')).toBeTruthy();
  expect(screen.getByText('완료로 옮길까요?')).toBeTruthy();
  expect(onComplete).not.toHaveBeenCalled();
  fireEvent.press(screen.getByTestId('card-now-complete'));
  expect(onComplete).toHaveBeenCalledTimes(1);
  screen.rerender(<CardNowPanel now={now} history={[]} allConfirmed onComplete={onComplete} completeDisabled />);
  fireEvent.press(screen.getByTestId('card-now-complete'));
  expect(onComplete).toHaveBeenCalledTimes(1);
});

test('요청이 빈 내 차례는 꼬리표를 남긴다', () => {
  const screen = render(<CardNowPanel now={{ ...now, turn: 'user', ask: '' }} history={[]} />);
  expect(screen.getByText('내 차례')).toBeTruthy();
});
