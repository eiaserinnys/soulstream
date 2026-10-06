jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');

import React from 'react';
import { fireEvent, render, renderHook } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { cardFixture } from '../../../test-support/cards';
import { useTokens } from '../../../theme';
import { CardRow } from '../CardRow';

test('요약 행은 번호, 한 줄 제목, 담당 초상만 보이고 전체 행을 연다', () => {
  const onOpen = jest.fn();
  const card = cardFixture({ id: 'summary-card', number: 412, title: '긴 제목 '.repeat(12), assigneeAgentId: '로젤린' });
  const screen = render(<CardRow api={null} card={card} variant="summary" onOpen={onOpen} />);

  expect(screen.getByText('#412')).toBeTruthy();
  expect(screen.getByTestId('card-summary-card-summary-title').props.numberOfLines).toBe(1);
  expect(screen.getByTestId('card-summary-card-avatar')).toBeTruthy();
  expect(screen.queryByText('요청 원문')).toBeNull();
  expect(screen.queryByText('막힘')).toBeNull();

  fireEvent.press(screen.getByTestId('card-row-summary-card-summary'));
  expect(onOpen).toHaveBeenCalledTimes(1);
});

test('번호 없는 요약 행은 번호만 생략한다', () => {
  const screen = render(<CardRow api={null} card={cardFixture({ id: 'legacy-summary-card', number: null })}
    variant="summary" onOpen={jest.fn()} />);

  expect(screen.queryByTestId('card-legacy-summary-card-number')).toBeNull();
  expect(screen.getByTestId('card-legacy-summary-card-summary-title')).toBeTruthy();
});

test('요약 행은 번호의 자연 폭과 본문 제목을 유지한다', () => {
  const screen = render(<CardRow api={null} card={cardFixture({ id: 'pressed-summary-card', number: 412, title: '접근성 점검' })}
    variant="summary" onOpen={jest.fn()} />);
  const tokens = renderHook(() => useTokens()).result.current;
  const number = StyleSheet.flatten(screen.getByTestId('card-pressed-summary-card-number').props.style);
  const title = StyleSheet.flatten(screen.getByTestId('card-pressed-summary-card-summary-title').props.style);
  expect(number.flexShrink).toBe(0);
  expect(number.minWidth).toBeUndefined();
  expect(title.fontSize).toBe(tokens.foundation.typography.body.fontSize);
  expect(title.flex).toBe(1);
});

test('요약 행은 목록에서 전달한 번호 템플릿으로 열 폭을 맞추고 숫자를 고정 폭으로 그린다', () => {
  const screen = render(<CardRow api={null} card={cardFixture({ id: 'short-number', number: 7 })}
    variant="summary" summaryNumberTemplate="#1024" onOpen={jest.fn()} />);
  const number = screen.getByTestId('card-short-number-number');
  const reserve = screen.UNSAFE_getByProps({ testID: 'card-short-number-number-reserve' });

  expect(reserve.props.children).toBe('#1024');
  expect(reserve.props.accessible).toBe(false);
  expect(reserve.props.accessibilityElementsHidden).toBe(true);
  expect(reserve.props.importantForAccessibility).toBe('no-hide-descendants');
  expect(StyleSheet.flatten(number.props.style).fontVariant).toContain('tabular-nums');
});
