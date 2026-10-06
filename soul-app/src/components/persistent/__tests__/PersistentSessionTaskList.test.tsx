jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');

import React from 'react';
import { act, fireEvent, render, renderHook, waitFor } from '@testing-library/react-native';
import { Pressable, StyleSheet } from 'react-native';
import type { CardStatus } from '../../../api/cardTypes';
import { cardFixture } from '../../../test-support/cards';
import { useAuthStore } from '../../../store/authStore';
import { useSettingsStore } from '../../../store/settingsStore';
import { useTokens } from '../../../theme';
import { PersistentSessionTaskList } from '../PersistentSessionTaskList';

beforeEach(() => {
  const payload = Buffer.from(JSON.stringify({ email: 'task-list@example.com', sub: 'task-list@example.com', exp: 2_000_000_000 })).toString('base64url');
  useAuthStore.setState({ jwt: `header.${payload}.signature` });
  useSettingsStore.setState({ serverUrl: 'https://task-list.test', persistentSessionDevicePrefs: {} });
});

test('전체 목록은 global useCardList 결과의 활성 카드를 묶고 행 열기를 전달한다', async () => {
  const statuses: CardStatus[] = ['todo', 'queued', 'running', 'blocked', 'review', 'done', 'cancelled'];
  const cards = statuses.map((status) => cardFixture({ id: `card-${status}`, status, number: status === 'todo' ? null : 1 }));
  const listCards = jest.fn().mockResolvedValue({ cards });
  const onOpenCard = jest.fn();
  const screen = render(<PersistentSessionTaskList api={{ listCards } as any} onOpenCard={onOpenCard} />);

  await waitFor(() => expect(screen.getByTestId('persistent-task-group-running')).toBeTruthy());
  expect(listCards).toHaveBeenCalledWith(undefined, { includeCompleted: false });
  expect(screen.getAllByTestId(/^persistent-task-group-(running|blocked|review|queued|todo)$/).map((group) => group.props.testID)).toEqual([
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
  const tokens = renderHook(() => useTokens()).result.current;
  expect(StyleSheet.flatten(screen.getByTestId('persistent-task-list-error-state').props.style)).toMatchObject({
    paddingVertical: tokens.foundation.pageInset,
  });
  expect(StyleSheet.flatten(screen.getByTestId('persistent-task-list-error-state').props.style).paddingHorizontal).toBeUndefined();
  expect(StyleSheet.flatten(screen.getByLabelText('작업 목록 다시 조회').props.style).backgroundColor).toBe(tokens.persistentSession.paper);
  act(() => screen.root.find((node) => node.props.accessibilityLabel === '작업 목록 다시 조회'
    && typeof node.props.onPress === 'function').props.onPress());
  await waitFor(() => expect(listCards).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByTestId('card-row-card-running-retry-summary')).toBeTruthy());
  expect(listCards).toHaveBeenCalledTimes(2);
});

test('한 목록의 가장 긴 카드 번호가 모든 요약 행의 번호 폭을 정한다', async () => {
  const numbers = [7, 98, 412, 1024];
  const cards = numbers.map((number) => cardFixture({ id: `number-${number}`, number, status: 'running', title: '접근성 점검' }));
  const screen = render(<PersistentSessionTaskList api={{ listCards: jest.fn().mockResolvedValue({ cards }) } as any}
    onOpenCard={jest.fn()} />);

  await waitFor(() => expect(screen.getByTestId('persistent-task-group-running')).toBeTruthy());
  expect(numbers.map((number) => screen.UNSAFE_getByProps({ testID: `card-number-${number}-number-reserve` }).props.children))
    .toEqual(['#1024', '#1024', '#1024', '#1024']);
});

test('세 자리 번호만 있는 목록은 세 자리 번호 폭을 유지한다', async () => {
  const cards = [412, 415].map((number) => cardFixture({ id: `number-${number}`, number, status: 'running' }));
  const screen = render(<PersistentSessionTaskList api={{ listCards: jest.fn().mockResolvedValue({ cards }) } as any}
    onOpenCard={jest.fn()} />);

  await waitFor(() => expect(screen.getByTestId('persistent-task-group-running')).toBeTruthy());
  expect(screen.UNSAFE_getByProps({ testID: 'card-number-412-number-reserve' }).props.children).toBe('#412');
  expect(screen.UNSAFE_getByProps({ testID: 'card-number-415-number-reserve' }).props.children).toBe('#412');
});

test('드래프트만 처음 접히고 모든 상태 머리에서 개수와 펼침 상태를 보여 준다', async () => {
  const cards = [
    cardFixture({ id: 'task-running', number: 7, status: 'running' }),
    cardFixture({ id: 'task-todo', number: 1024, status: 'todo' }),
  ];
  const screen = render(<PersistentSessionTaskList api={{ listCards: jest.fn().mockResolvedValue({ cards }) } as any}
    onOpenCard={jest.fn()} />);

  await waitFor(() => expect(screen.getByTestId('persistent-task-group-running')).toBeTruthy());
  const draftHeader = screen.getByTestId('persistent-task-group-header-todo');
  expect(draftHeader.props.accessibilityRole).toBe('button');
  expect(draftHeader.props.accessibilityState).toEqual({ expanded: false });
  expect(screen.getByTestId('persistent-task-group-header-running').props.accessibilityState).toEqual({ expanded: true });
  expect(screen.getByTestId('persistent-task-group-count-todo').props.children).toBe('1개');
  expect(screen.queryByTestId('card-row-task-todo-summary')).toBeNull();
  expect(screen.UNSAFE_getByProps({ testID: 'card-task-running-number-reserve' }).props.children).toBe('#1024');

  fireEvent.press(draftHeader);
  expect(screen.getByTestId('persistent-task-group-header-todo').props.accessibilityState).toEqual({ expanded: true });
  expect(screen.getByTestId('card-row-task-todo-summary')).toBeTruthy();
});

test('요약 중 목록을 display none으로 숨겼다가 되돌아와도 요청과 목록 상태를 유지한다', async () => {
  const cards = [cardFixture({ id: 'visible-task', status: 'running' })];
  const listCards = jest.fn().mockResolvedValue({ cards });
  const api = { listCards } as any;
  function Harness() {
    const [visible, setVisible] = React.useState(true);
    return <>
      <PersistentSessionTaskList api={api} onOpenCard={jest.fn()} visible={visible} />
      <Pressable testID="toggle-summary" onPress={() => setVisible(value => !value)} />
    </>;
  }
  const screen = render(<Harness />);

  await waitFor(() => expect(screen.getByTestId('card-row-visible-task-summary')).toBeTruthy());
  const listBefore = screen.getByTestId('persistent-task-list');
  fireEvent.press(screen.getByTestId('toggle-summary'));
  expect(StyleSheet.flatten(screen.getByTestId('persistent-task-list', { includeHiddenElements: true }).props.style).display).toBe('none');
  expect(screen.getByTestId('card-row-visible-task-summary', { includeHiddenElements: true })).toBeTruthy();
  fireEvent.press(screen.getByTestId('toggle-summary'));
  expect(screen.getByTestId('persistent-task-list')).toBe(listBefore);
  expect(listCards).toHaveBeenCalledTimes(1);
});
