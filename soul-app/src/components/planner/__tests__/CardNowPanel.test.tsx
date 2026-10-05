import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import type { CardNow, CardNowHistoryEntry } from '../../../api/cardTypes';
import { CardNowPanel } from '../CardNowPanel';

const now: CardNow = { text: '지금 확인 중입니다.', turn: 'agent', ask: null, updatedAt: '2026-10-05T01:00:00Z', sessionId: 's1' };
const history: CardNowHistoryEntry[] = [
  { text: '지난 확인입니다.', turn: 'user', ask: '이 내용을 봐 주세요.', at: '2026-10-05T00:00:00Z' },
  { text: now.text, turn: now.turn, ask: now.ask, at: now.updatedAt },
];

test('이전·다음은 상황만 넘기고 최신 now 및 확인 항목 상태를 바꾸지 않는다', () => {
  const screen = render(<CardNowPanel now={now} history={history} />);
  expect(screen.getByText(now.text)).toBeTruthy();
  fireEvent.press(screen.getByLabelText('이전 상황'));
  expect(screen.getByText('지난 확인입니다.')).toBeTruthy();
  expect(screen.getByText('아래 확인 항목은 지금 상태입니다.')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('최신 상황'));
  expect(screen.getByText(now.text)).toBeTruthy();
});

test.each([
  ['agent', '에이전트 차례'], ['user', '내 차례'], ['outside', '바깥 대기'],
] as const)('%s 차례의 표기를 보여 준다', (turn, label) => {
  const screen = render(<CardNowPanel now={{ ...now, turn, ask: turn === 'user' ? '확인해 주세요.' : null }} history={[]} />);
  expect(screen.getByText(label)).toBeTruthy();
});

test('모두 확인된 최신 상황은 완료 물음만 보여 주고 저장 동작을 실행하지 않는다', () => {
  const screen = render(<CardNowPanel now={now} history={[]} allConfirmed />);
  expect(screen.getByText('모두 확인했습니다. 완료로 옮길까요?')).toBeTruthy();
  expect(screen.queryByLabelText('완료 저장')).toBeNull();
});
