jest.mock('../../api/client', () => ({ createApiClient: () => mockApi }));
jest.mock('../useSSEStream', () => ({
  CATALOG_STREAM_EVENTS: [
    'stream_meta', 'session_list', 'session_created', 'session_updated',
    'session_deleted', 'catalog_updated', 'folder_updated', 'card_updated',
  ],
  useSSEStream: (options: unknown) => { mockStream.options = options as typeof mockStream.options; },
}));
jest.mock('../../store/settingsStore', () => ({
  useSettingsStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector({
      serverUrl: 'https://measure.test',
      getPersistentSessionDevicePreference: () => ({ collapsedTaskGroups: [] }),
      setPersistentSessionCollapsedTaskGroups: () => undefined,
    }),
    {
      getState: () => ({ serverUrl: 'https://measure.test' }),
      subscribe: () => () => undefined,
    },
  ),
}));
jest.mock('../../store/authStore', () => ({
  useAuthStore: Object.assign(
    (selector: (state: { jwt: string | null }) => unknown) => selector({ jwt: null }),
    { getState: () => ({ jwt: null, rejectAuth: jest.fn() }), subscribe: () => () => undefined },
  ),
}));

import { act, render } from '@testing-library/react-native';
import type { ApiClient } from '../../api/client';
import type { CardDto } from '../../api/cardTypes';
import { PersistentSessionTaskList } from '../../components/persistent/PersistentSessionTaskList';
import { CARD_REFRESH_WINDOW_MS } from '../../lib/card-refresh-window';
import { useCardStore } from '../../store/cardStore';
import { usePlannerStore } from '../../store/plannerStore';
import { cardFixture } from '../../test-support/cards';
import { useSessionsStream } from '../useSessionsStream';

var mockApi: ApiClient;
const mockStream: { options: { onEvent: (type: string, data: unknown, id?: string) => void } | null } = {
  options: null,
};

function option() {
  if (!mockStream.options) throw new Error('stream not mounted');
  return mockStream.options;
}

function Harness({ api, visible }: { api: ApiClient; visible: boolean }) {
  useSessionsStream();
  return <PersistentSessionTaskList api={api} onOpenCard={() => undefined} visible={visible} />;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function emit(type: string, data: unknown) {
  act(() => option().onEvent(type, data));
}

function setup(cards: CardDto[]) {
  useCardStore.setState({ rows: {}, seq: 0, rowSeq: {}, details: {}, pendingItemConfirmations: {} });
  usePlannerStore.getState().resetForTest();
  let rows = cards;
  const listCards = jest.fn(async () => ({ cards: rows }));
  const getCard = jest.fn(async (id: string) => {
    const card = rows.find((candidate) => candidate.id === id) ?? cardFixture({ id });
    return { card: { ...card, version: card.version + 1, title: `updated:${id}` } } as never;
  });
  mockApi = {
    listCards,
    getCard,
    catalogStreamUrl: () => 'https://measure.test/stream',
    getSessionsByIds: jest.fn(),
  } as unknown as ApiClient;
  return { api: mockApi, listCards, getCard, setRows: (next: CardDto[]) => { rows = next; } };
}

beforeEach(() => {
  mockStream.options = null;
});

afterEach(() => {
  jest.useRealTimers();
});

test('표시 중 카드 갱신 3건: 목록은 한 창에 1회, 표시 중 카드 상세만 3회', async () => {
  jest.useFakeTimers();
  const cards = ['card-a', 'card-b', 'card-c'].map((id) => cardFixture({ id, status: 'running' }));
  const { api, listCards, getCard } = setup(cards);
  render(<Harness api={api} visible />);
  await flush();
  expect(listCards).toHaveBeenCalledTimes(1);

  emit('card_updated', { cardId: 'card-a', folderId: 'folder-1' });
  await advance(100);
  emit('card_updated', { cardId: 'card-b', folderId: 'folder-1' });
  await advance(100);
  const lastEventAt = Date.now();
  emit('card_updated', { cardId: 'card-c', folderId: 'folder-1' });
  await flush();

  expect(getCard).toHaveBeenCalledTimes(3);
  expect(listCards).toHaveBeenCalledTimes(1);

  await advance(CARD_REFRESH_WINDOW_MS);
  expect(listCards).toHaveBeenCalledTimes(2);
  expect(Date.now() - lastEventAt).toBe(CARD_REFRESH_WINDOW_MS);
});

test('숨김 중 카드 갱신 3건: 목록 0회, 복귀할 때 최신 목록 1회', async () => {
  jest.useFakeTimers();
  const cards = ['card-a', 'card-b', 'card-c'].map((id) => cardFixture({ id, status: 'running' }));
  const { api, listCards, getCard, setRows } = setup(cards);
  const screen = render(<Harness api={api} visible />);
  await flush();
  expect(listCards).toHaveBeenCalledTimes(1);

  screen.rerender(<Harness api={api} visible={false} />);
  emit('card_updated', { cardId: 'card-a', folderId: 'folder-1' });
  await advance(100);
  emit('card_updated', { cardId: 'card-b', folderId: 'folder-1' });
  await advance(100);
  emit('card_updated', { cardId: 'card-c', folderId: 'folder-1' });
  await advance(CARD_REFRESH_WINDOW_MS * 2);

  expect(getCard).toHaveBeenCalledTimes(3);
  expect(listCards).toHaveBeenCalledTimes(1);

  const newCard = cardFixture({ id: 'card-new', status: 'running' });
  setRows([...cards, newCard]);
  const shownAt = Date.now();
  screen.rerender(<Harness api={api} visible />);
  await flush();
  expect(listCards).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId('card-row-card-new-summary')).toBeTruthy();
  expect(Date.now() - shownAt).toBe(0);
});

test('목록에 없던 새 카드 갱신: 개별 상세 0회, 목록 재조회 1회로 표시된다', async () => {
  jest.useFakeTimers();
  const card = cardFixture({ id: 'card-a', status: 'running' });
  const { api, listCards, getCard, setRows } = setup([card]);
  const screen = render(<Harness api={api} visible />);
  await flush();
  expect(listCards).toHaveBeenCalledTimes(1);

  const lastEventAt = Date.now();
  emit('card_updated', { cardId: 'card-new', folderId: 'folder-1' });
  await flush();
  expect(getCard).not.toHaveBeenCalled();
  expect(listCards).toHaveBeenCalledTimes(1);

  const newCard = cardFixture({ id: 'card-new', status: 'running' });
  setRows([card, newCard]);
  await advance(CARD_REFRESH_WINDOW_MS);
  expect(listCards).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId('card-row-card-new-summary')).toBeTruthy();
  expect(Date.now() - lastEventAt).toBe(CARD_REFRESH_WINDOW_MS);
});
