jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');

import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import type { CardStatus } from '../../../api/cardTypes';
import { cardFixture } from '../../../test-support/cards';
import { PersistentSessionTaskList } from '../PersistentSessionTaskList';

test('전체 목록은 global useCardList 결과의 활성 카드를 묶고 행 열기를 전달한다', async () => {
  const statuses: CardStatus[] = ['todo', 'queued', 'running', 'blocked', 'review', 'done', 'cancelled'];
  const cards = statuses.map((status) => cardFixture({ id: `card-${status}`, status, number: status === 'todo' ? null : 1 }));
  const listCards = jest.fn().mockResolvedValue({ cards });
  const onOpenCard = jest.fn();
  const screen = render(<PersistentSessionTaskList api={{ listCards } as any} onOpenCard={onOpenCard} />);

  await waitFor(() => expect(screen.getByTestId('persistent-task-group-running')).toBeTruthy());
  expect(listCards).toHaveBeenCalledWith(undefined, { includeCompleted: false });
  expect(screen.getAllByTestId(/persistent-task-group-/).map((group) => group.props.testID)).toEqual([
    'persistent-task-group-running', 'persistent-task-group-blocked', 'persistent-task-group-review',
    'persistent-task-group-queued', 'persistent-task-group-todo',
  ]);
  expect(screen.queryByTestId('card-row-card-done-summary')).toBeNull();
  expect(screen.queryByTestId('card-row-card-cancelled-summary')).toBeNull();
  expect(screen.queryByTestId('card-card-todo-number')).toBeNull();

  fireEvent.press(screen.getByTestId('card-row-card-running-summary'));
  expect(onOpenCard).toHaveBeenCalledWith('card-running');
});

test('전체 목록 조회 실패에서 기존 새로고침 동작으로 다시 불러온다', async () => {
  const running = cardFixture({ id: 'card-running-retry', status: 'running' });
  const listCards = jest.fn().mockRejectedValueOnce(new Error('일시적인 조회 실패')).mockResolvedValue({ cards: [running] });
  const screen = render(<PersistentSessionTaskList api={{ listCards } as any} onOpenCard={jest.fn()} />);

  await waitFor(() => expect(screen.getByText('일시적인 조회 실패')).toBeTruthy());
  fireEvent.press(screen.getByLabelText('작업 목록 다시 조회'));
  await waitFor(() => expect(screen.getByTestId('card-row-card-running-retry-summary')).toBeTruthy());
  expect(listCards).toHaveBeenCalledTimes(2);
});
