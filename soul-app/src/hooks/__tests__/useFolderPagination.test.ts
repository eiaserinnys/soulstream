import { renderHook, act } from '@testing-library/react-native';
import { useSessionStore } from '../../store/sessionStore';
import type { Session } from '../../api/types';
import { useAuthStore } from '../../store/authStore';
import { resetAuthScopeForTest } from '../../lib/auth-scope';

// settingsStore mock — 훅이 selector 형태로 serverUrl을 읽는다.
const mockServerUrl = 'https://server.test';
jest.mock('../../store/settingsStore', () => ({
  useSettingsStore: Object.assign(
    <T,>(selector: (s: { serverUrl: string }) => T): T =>
      selector({ serverUrl: mockServerUrl }),
    {
      getState: () => ({ serverUrl: mockServerUrl }),
      subscribe: () => () => undefined,
    },
  ),
}));

// createApiClient mock — getCatalog만 검증 대상.
const mockGetCatalog = jest.fn();
jest.mock('../../api/client', () => ({
  createApiClient: () => ({
    getCatalog: mockGetCatalog,
  }),
}));

// sessionStore는 실제 구현을 사용한다 (mergeSessions 동작 자체와 store 격리 검증을 위해).
// 다른 테스트와 격리하기 위해 매 테스트 전 store를 초기화한다.

import { useFolderPagination } from '../useFolderPagination';

function s(id: string, updatedAt: string, folderId?: string | null): Session {
  return {
    agentSessionId: id,
    displayName: id,
    status: 'idle',
    createdAt: updatedAt,
    updatedAt,
    folderId,
  };
}

beforeEach(() => {
  mockGetCatalog.mockReset();
  useAuthStore.getState().setJwt('account-a');
  resetAuthScopeForTest();
  // sessionStore 직접 reset.
  useSessionStore.setState({
    sessions: {},
    catalog: { folders: [], sessions: {} },
    catalogReady: false,
  });
});

describe('useFolderPagination', () => {
  test('folderId가 null이면 items=[], getCatalog 호출 없음', async () => {
    const { result } = renderHook(() => useFolderPagination(null));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.items).toEqual([]);
    expect(mockGetCatalog).not.toHaveBeenCalled();
  });

  test('folderId 부여 시 마운트에서 첫 페이지 자동 fetch', async () => {
    mockGetCatalog.mockResolvedValue({
      folders: [],
      sessions: {},
      sessionList: [s('a', '2026-05-05T00:00:00Z')],
    });
    const { result } = renderHook(() => useFolderPagination('f1'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockGetCatalog).toHaveBeenCalledTimes(1);
    expect(mockGetCatalog).toHaveBeenCalledWith({
      folder_id: 'f1',
      limit: 50,
      offset: 0,
    });
    expect(result.current.items.map((it) => it.agentSessionId)).toEqual(['a']);
  });

  test('loadMore 추가 호출 시 items 누적 (id dedup, updated_at DESC 정렬)', async () => {
    // 1차 응답: PAGE_SIZE(50)개 — 첫 페이지가 꽉 차야 hasMore=true 유지되어 2차 fetch 가능.
    // a, b를 포함하고 나머지는 더 오래된 더미 세션으로 패딩.
    const dummies = Array.from({ length: 48 }, (_, i) =>
      s(`x${i}`, `2026-04-${String(i + 1).padStart(2, '0')}T00:00:00Z`)
    );
    mockGetCatalog
      .mockResolvedValueOnce({
        folders: [],
        sessions: {},
        sessionList: [
          s('a', '2026-05-05T00:00:00Z'),
          s('b', '2026-05-04T00:00:00Z'),
          ...dummies,
        ],
      })
      .mockResolvedValueOnce({
        folders: [],
        sessions: {},
        sessionList: [
          s('b', '2026-05-06T00:00:00Z'), // 더 새로운 updatedAt으로 갱신 (1차 b를 덮어씀)
          s('c', '2026-05-03T00:00:00Z'),
        ],
      });

    const { result } = renderHook(() => useFolderPagination('f1'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.items).toHaveLength(50);
    expect(result.current.items[0].agentSessionId).toBe('a'); // 가장 최근

    await act(async () => {
      await result.current.loadMore();
    });

    // 누적·dedup: b는 1차 + 2차 합쳐 1건만 남고, 갱신본의 updated_at을 가진다.
    // 1차 50개 + 2차 새 c 1개 = 51개 (b는 dedup).
    expect(result.current.items).toHaveLength(51);
    const top3 = result.current.items.slice(0, 3).map((it) => it.agentSessionId);
    // updatedAt DESC: b(2026-05-06) > a(2026-05-05) > c(2026-05-03)
    expect(top3).toEqual(['b', 'a', 'c']);
    expect(
      result.current.items.find((it) => it.agentSessionId === 'b')?.updatedAt
    ).toBe('2026-05-06T00:00:00Z');
  });

  test('응답 list.length < 50이면 hasMore=false → loadMore 추가 호출 안 일어남', async () => {
    mockGetCatalog.mockResolvedValueOnce({
      folders: [],
      sessions: {},
      sessionList: [s('a', '2026-05-05T00:00:00Z')],
    });
    const { result } = renderHook(() => useFolderPagination('f1'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.hasMore).toBe(false);
    expect(mockGetCatalog).toHaveBeenCalledTimes(1);

    // hasMore=false 상태에서 loadMore 재호출은 noop.
    await act(async () => {
      await result.current.loadMore();
    });
    expect(mockGetCatalog).toHaveBeenCalledTimes(1);
  });

  test('folderId 변경 시 items/offset/hasMore reset 후 새 폴더 자동 fetch', async () => {
    mockGetCatalog.mockResolvedValueOnce({
      folders: [],
      sessions: {},
      sessionList: [s('a', '2026-05-05T00:00:00Z')],
    });
    const { result, rerender } = renderHook(
      ({ folderId }: { folderId: string | null }) => useFolderPagination(folderId),
      { initialProps: { folderId: 'f1' } }
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.items.map((it) => it.agentSessionId)).toEqual(['a']);

    // 폴더 변경 — items 리셋, 새 폴더로 fetch.
    mockGetCatalog.mockResolvedValueOnce({
      folders: [],
      sessions: {},
      sessionList: [s('z', '2026-05-04T00:00:00Z')],
    });
    rerender({ folderId: 'f2' });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockGetCatalog).toHaveBeenLastCalledWith({
      folder_id: 'f2',
      limit: 50,
      offset: 0,
    });
    expect(result.current.items.map((it) => it.agentSessionId)).toEqual(['z']);
  });

  test('loading 중 loadMore 재호출은 무시 (loadingRef 가드)', async () => {
    let resolveFirst: ((v: unknown) => void) | null = null;
    mockGetCatalog.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveFirst = res;
        })
    );

    const { result } = renderHook(() => useFolderPagination('f1'));
    // 첫 페이지 fetch가 in-flight인 상태에서 loadMore 재호출.
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockGetCatalog).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.loadMore();
    });
    // in-flight 가드로 두 번째 호출은 차단되어야 한다.
    expect(mockGetCatalog).toHaveBeenCalledTimes(1);

    // 첫 페이지 응답을 풀어준다.
    await act(async () => {
      resolveFirst?.({
        folders: [],
        sessions: {},
        sessionList: [s('a', '2026-05-05T00:00:00Z')],
      });
      await Promise.resolve();
    });
    expect(result.current.items.map((it) => it.agentSessionId)).toEqual(['a']);
  });

  test('회귀 가드 — 글로벌 store.setSessions로 갈아엎어도 훅 items는 영향 없음 (정본 분리)', async () => {
    mockGetCatalog.mockResolvedValueOnce({
      folders: [],
      sessions: {},
      sessionList: [
        s('a', '2026-05-05T00:00:00Z'),
        s('b', '2026-05-04T00:00:00Z'),
      ],
    });
    const { result } = renderHook(() => useFolderPagination('f1'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.items.map((it) => it.agentSessionId)).toEqual(['a', 'b']);

    // 외부에서 글로벌 store를 통째로 갈아엎는다 (gap refetch가 setSessions 호출하는 시나리오 시뮬레이션).
    act(() => {
      useSessionStore.getState().setSessions([]);
    });

    // 훅의 items는 영향받지 않는다 — 표시 정본은 지역 상태이므로.
    expect(result.current.items.map((it) => it.agentSessionId)).toEqual(['a', 'b']);
  });

  test('활성 폴더와 무관한 글로벌 session 변경은 items 참조를 바꾸지 않는다', async () => {
    mockGetCatalog.mockResolvedValueOnce({
      folders: [],
      sessions: {},
      sessionList: [s('a', '2026-05-05T00:00:00Z', 'f1')],
    });
    const { result } = renderHook(() => useFolderPagination('f1'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const beforeItems = result.current.items;

    act(() => {
      useSessionStore
        .getState()
        .upsertSession(s('other', '2026-05-06T00:00:00Z', 'f2'));
    });

    expect(result.current.items).toBe(beforeItems);
    expect(result.current.items.map((it) => it.agentSessionId)).toEqual(['a']);
  });

  test('현재 폴더의 세션이 다른 폴더로 이동하면 지역 items에서 제거한다', async () => {
    mockGetCatalog.mockResolvedValueOnce({
      folders: [],
      sessions: {},
      sessionList: [s('a', '2026-05-05T00:00:00Z', 'f1')],
    });
    const { result } = renderHook(() => useFolderPagination('f1'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.items.map((it) => it.agentSessionId)).toEqual(['a']);

    act(() => {
      useSessionStore
        .getState()
        .upsertSession(s('a', '2026-05-06T00:00:00Z', 'f2'));
    });

    expect(result.current.items).toEqual([]);
  });

  test('scope 전환 뒤 이전 폴더 응답이 늦게 와도 지역 items와 전역 store를 오염시키지 않는다', async () => {
    let resolveOld!: (value: unknown) => void;
    mockGetCatalog
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce({
        folders: [],
        sessions: {},
        sessionList: [s('account-b', '2026-05-06T00:00:00Z', 'f1')],
      });

    const { result } = renderHook(() => useFolderPagination('f1'));
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      useAuthStore.getState().setJwt('account-b');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockGetCatalog).toHaveBeenCalledTimes(2);
    expect(result.current.items.map((item) => item.agentSessionId)).toEqual(['account-b']);
    await act(async () => {
      resolveOld({
        folders: [],
        sessions: {},
        sessionList: [s('old-account', '2026-05-05T00:00:00Z', 'f1')],
      });
      await Promise.resolve();
    });

    expect(result.current.items.map((item) => item.agentSessionId)).toEqual(['account-b']);
    expect(useSessionStore.getState().sessions['old-account']).toBeUndefined();
  });
});
