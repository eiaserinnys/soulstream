jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');

import React from 'react';
import { act, fireEvent, render, renderHook, waitFor } from '@testing-library/react-native';
import { Pressable, StyleSheet } from 'react-native';
import type { CardStatus } from '../../../../../packages/wire-schema/generated/typescript/index';
import { cardFixture } from '../../../test-support/cards';
import { useAuthStore } from '../../../store/authStore';
import { useCardStore } from '../../../store/cardStore';
import { usePlannerStore } from '../../../store/plannerStore';
import { useSettingsStore } from '../../../store/settingsStore';
import { useTokens } from '../../../theme';
import { PersistentSessionTaskList } from '../PersistentSessionTaskList';

beforeEach(() => {
  const payload = Buffer.from(JSON.stringify({ email: 'task-list@example.com', sub: 'task-list@example.com', exp: 2_000_000_000 })).toString('base64url');
  useAuthStore.setState({ jwt: `header.${payload}.signature` });
  useSettingsStore.setState({ serverUrl: 'https://task-list.test', persistentSessionDevicePrefs: {} });
  useCardStore.setState({ rows: {}, seq: 0, rowSeq: {}, details: {}, pendingItemConfirmations: {} });
  usePlannerStore.getState().resetForTest();
});

test('전체 목록은 global useCardList 결과의 활성 카드를 묶고 행 열기를 전달한다', async () => {
  const statuses: CardStatus[] = ['todo', 'queued', 'running', 'blocked', 'review', 'on_hold', 'done', 'cancelled'];
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
  expect(screen.queryByTestId('persistent-task-group-on_hold')).toBeNull();
  expect(screen.queryByTestId('card-row-card-on_hold-summary')).toBeNull();
  expect(screen.queryByTestId('card-card-todo-number')).toBeNull();

  fireEvent.press(screen.getByTestId('card-row-card-running-summary'));
  expect(onOpenCard).toHaveBeenCalledWith('card-running');
});

test('첫 목록 응답 전에는 스토어에 남은 오래된 실행 중 행을 그리지 않는다', async () => {
  let respond!: (value: { cards: ReturnType<typeof cardFixture>[] }) => void;
  const listCards = jest.fn(() => new Promise<{ cards: ReturnType<typeof cardFixture>[] }>((resolve) => { respond = resolve; }));
  useCardStore.setState({
    rows: { stale: cardFixture({ id: 'stale', status: 'running', version: 1 }) },
    seq: 1, rowSeq: { stale: 1 },
  });
  const screen = render(<PersistentSessionTaskList api={{ listCards } as any} onOpenCard={jest.fn()} />);

  expect(screen.getByTestId('persistent-task-list-loading')).toBeTruthy();
  expect(screen.queryByTestId('card-row-stale-summary')).toBeNull();
  expect(screen.queryByTestId('persistent-task-group-running')).toBeNull();

  await act(async () => { respond({ cards: [cardFixture({ id: 'stale', status: 'review', version: 2 })] }); });

  await waitFor(() => expect(screen.getByTestId('persistent-task-group-review')).toBeTruthy());
  expect(screen.getByTestId('card-row-stale-summary')).toBeTruthy();
  expect(screen.queryByTestId('persistent-task-group-running')).toBeNull();
  expect(useCardStore.getState().rows.stale).toMatchObject({ status: 'review', version: 2 });
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

test('contentInset은 스크롤 내용의 위아래 여백에 더한다', async () => {
  const cards = [cardFixture({ id: 'inset-task', status: 'running' })];
  const screen = render(<PersistentSessionTaskList api={{ listCards: jest.fn().mockResolvedValue({ cards }) } as any}
    onOpenCard={jest.fn()} contentInset={{ top: 56, bottom: 152 }} />);

  await waitFor(() => expect(screen.getByTestId('persistent-task-group-running')).toBeTruthy());
  const tokens = renderHook(() => useTokens()).result.current;
  expect(StyleSheet.flatten(screen.getByTestId('persistent-task-list').props.contentContainerStyle)).toMatchObject({
    paddingTop: 56,
    paddingBottom: 152,
    paddingHorizontal: tokens.uiSpacing.sm,
  });
});

test('로딩·빈 목록·실패 화면도 목록과 같은 위 여백(contentInset.top)을 받는다', async () => {
  const loading = render(<PersistentSessionTaskList api={{ listCards: () => new Promise<never>(() => {}) } as any}
    onOpenCard={jest.fn()} contentInset={{ top: 56, bottom: 152 }} />);
  await waitFor(() => expect(loading.getByTestId('persistent-task-list-loading')).toBeTruthy());
  expect(StyleSheet.flatten(loading.getByTestId('persistent-task-list-loading').props.style).paddingTop).toBe(56);

  const empty = render(<PersistentSessionTaskList api={{ listCards: jest.fn().mockResolvedValue({ cards: [] }) } as any}
    onOpenCard={jest.fn()} contentInset={{ top: 56, bottom: 152 }} />);
  await waitFor(() => expect(empty.getByTestId('persistent-task-list-empty')).toBeTruthy());
  expect(StyleSheet.flatten(empty.getByTestId('persistent-task-list-empty').props.style).paddingTop).toBe(56);

  const error = render(<PersistentSessionTaskList api={{ listCards: jest.fn().mockRejectedValue(new Error('일시적인 조회 실패')) } as any}
    onOpenCard={jest.fn()} contentInset={{ top: 56, bottom: 152 }} />);
  await waitFor(() => expect(error.getByTestId('persistent-task-list-error-state')).toBeTruthy());
  expect(StyleSheet.flatten(error.getByTestId('persistent-task-list-error-state').props.style).paddingTop).toBe(56);
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

test('숨김 동안 들어온 카드 갱신은 목록을 조회하지 않고, 보일 때 최신 목록을 한 번 받는다', async () => {
  const first = [cardFixture({ id: 'visible-task', status: 'running' })];
  const latest = [...first, cardFixture({ id: 'new-task', status: 'running' })];
  const listCards = jest.fn().mockResolvedValueOnce({ cards: first }).mockResolvedValue({ cards: latest });
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
  fireEvent.press(screen.getByTestId('toggle-summary'));
  act(() => {
    usePlannerStore.getState().invalidate('card');
    usePlannerStore.getState().invalidate('card');
  });
  expect(listCards).toHaveBeenCalledTimes(1);

  fireEvent.press(screen.getByTestId('toggle-summary'));
  await waitFor(() => expect(screen.getByTestId('card-row-new-task-summary')).toBeTruthy());
  expect(listCards).toHaveBeenCalledTimes(2);
});
