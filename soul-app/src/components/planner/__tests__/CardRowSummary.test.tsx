jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');

import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { cardFixture } from '../../../test-support/cards';
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
