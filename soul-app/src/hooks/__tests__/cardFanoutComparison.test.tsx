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

import { act, render, waitFor } from '@testing-library/react-native';
import type { ApiClient } from '../../api/client';
import { PersistentSessionTaskList } from '../../components/persistent/PersistentSessionTaskList';
import { useCardStore } from '../../store/cardStore';
import { usePlannerStore } from '../../store/plannerStore';
import { cardFixture } from '../../test-support/cards';
import { useSessionsStream } from '../useSessionsStream';

var mockApi: ApiClient;
const mockStream: { options: { onEvent: (type: string, data: unknown) => void } | null } = { options: null };

function Harness({ api, visible }: { api: ApiClient; visible: boolean }) {
  useSessionsStream();
  return <PersistentSessionTaskList api={api} onOpenCard={() => undefined} visible={visible} />;
}

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function measure(hidden: boolean) {
  useCardStore.setState({ rows: {}, seq: 0, rowSeq: {}, details: {}, pendingItemConfirmations: {} });
  usePlannerStore.getState().resetForTest();
  let rows = [
    cardFixture({ id: 'move', title: '이동 전', status: 'running' }),
    cardFixture({ id: 'done', title: '완료 전', status: 'running' }),
  ];
  const listCards = jest.fn(async () => {
    const snapshot = rows.filter(card => card.status !== 'done').map(card => ({ ...card }));
    await pause(10);
    return { cards: snapshot };
  });
  const getCard = jest.fn(async (id: string) => {
    const card = { ...rows.find(row => row.id === id)! };
    await pause(10);
    return { card } as never;
  });
  mockApi = { listCards, getCard, catalogStreamUrl: () => 'https://measure.test/stream',
    getSessionsByIds: jest.fn() } as unknown as ApiClient;
  const screen = render(<Harness api={mockApi} visible />);
  await waitFor(() => expect(screen.getByText('이동 전')).toBeTruthy());
  if (hidden) screen.rerender(<Harness api={mockApi} visible={false} />);

  const beforeList = listCards.mock.calls.length;
  const beforeDetail = getCard.mock.calls.length;
  const emit = (id: string) => act(() => mockStream.options!.onEvent('card_updated', { cardId: id, folderId: 'folder-1' }));

  rows = [...rows, cardFixture({ id: 'new', title: '새 카드', status: 'running' })];
  emit('new');
  await act(async () => { await pause(100); });
  rows = rows.map(card => card.id === 'move' ? { ...card, folderId: 'folder-2', title: '이동 후', version: 2 } : card);
  emit('move');
  await act(async () => { await pause(100); });
  rows = rows.map(card => card.id === 'done' ? { ...card, status: 'done' as const, version: 2 } : card);
  const lastEventAt = Date.now();
  emit('done');

  let hiddenCounts: { list: number; detail: number } | null = null;
  let shownAt = lastEventAt;
  let showList = beforeList;
  let showDetail = beforeDetail;
  if (hidden) {
    await act(async () => { await pause(650); });
    hiddenCounts = { list: listCards.mock.calls.length - beforeList, detail: getCard.mock.calls.length - beforeDetail };
    showList = listCards.mock.calls.length;
    showDetail = getCard.mock.calls.length;
    shownAt = Date.now();
    screen.rerender(<Harness api={mockApi} visible />);
  }

  await waitFor(() => {
    expect(screen.getByText('새 카드')).toBeTruthy();
    expect(screen.getByText('이동 후')).toBeTruthy();
    expect(screen.queryByText('완료 전')).toBeNull();
  }, { timeout: 3000, interval: 10 });
  const shown = Date.now();
  const result = {
    list: listCards.mock.calls.length - beforeList,
    detail: getCard.mock.calls.length - beforeDetail,
    hidden: hiddenCounts,
    returnList: hidden ? listCards.mock.calls.length - showList : null,
    returnDetail: hidden ? getCard.mock.calls.length - showDetail : null,
    lastToRowsMs: shown - lastEventAt,
    returnToRowsMs: hidden ? shown - shownAt : null,
  };
  screen.unmount();
  return result;
}

test('생성·이동·완료 SSE의 표시와 숨김·복귀 요청 수 및 최종 행 시간을 측정한다', async () => {
  const visible = [];
  const hidden = [];
  for (let i = 0; i < 3; i += 1) {
    visible.push(await measure(false));
    hidden.push(await measure(true));
  }
  console.log('CARD_FANOUT_COMPARISON', JSON.stringify({ visible, hidden }));
});
