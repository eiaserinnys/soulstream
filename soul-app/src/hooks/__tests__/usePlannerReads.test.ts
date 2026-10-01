import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ApiClient } from '../../api/client';
import type { PlannerFolderDetail, PlannerFolder, PlannerToday } from '../../api/plannerTypes';
import type { CatalogFolder } from '../../api/types';
import {
  usePlannerDaily,
  usePlannerPageDetail,
  usePlannerFolderDetail,
  usePlannerStarred,
} from '../usePlannerReads';
import { usePlannerStore } from '../../store/plannerStore';
import { useAuthStore } from '../../store/authStore';
import { useSettingsStore } from '../../store/settingsStore';
import { resetAuthScopeForTest } from '../../lib/auth-scope';

const daily: PlannerToday = {
  daily: {
    page: {
      id: 'daily',
      title: 'Daily',
      dailyDate: '2026-07-17',
      version: 1,
      archived: false,
      metadata: {},
      createdAt: '',
      updatedAt: '',
    },
    blocks: [],
    stateVector: 'sv',
  },
  projects: [],
  memoBlocks: [],
  folders: [],
  attention: [], running: [], queued: [],
  reviewSessionIds: [],
};

beforeEach(() => {
  useSettingsStore.setState({ serverUrl: 'https://planner.test' });
  useAuthStore.setState({ jwt: 'scope-a' });
  resetAuthScopeForTest();
  usePlannerStore.getState().resetForTest();
});

test('session_updated는 daily 재조회를 유발하지 않고 replay는 현재 화면만 재조회한다', async () => {
  const getPlannerToday = jest.fn().mockResolvedValue(daily);
  const api = { getPlannerToday } as unknown as ApiClient;
  const { rerender } = renderHook(
    ({ enabled }: { enabled: boolean }) => usePlannerDaily(api, '2026-07-17', enabled),
    { initialProps: { enabled: true } },
  );
  await waitFor(() => expect(getPlannerToday).toHaveBeenCalledTimes(1));

  act(() => usePlannerStore.getState().invalidate('session_updated'));
  await act(async () => Promise.resolve());
  expect(getPlannerToday).toHaveBeenCalledTimes(1);

  rerender({ enabled: false });
  act(() => usePlannerStore.getState().invalidate('replay'));
  await act(async () => Promise.resolve());
  expect(getPlannerToday).toHaveBeenCalledTimes(1);

  rerender({ enabled: true });
  await waitFor(() => expect(getPlannerToday).toHaveBeenCalledTimes(2));
});

test('늦게 도착한 이전 daily 응답은 최신 응답을 덮지 않는다', async () => {
  let resolveOld!: (value: PlannerToday) => void;
  let resolveLatest!: (value: PlannerToday) => void;
  const oldRequest = new Promise<PlannerToday>((resolve) => { resolveOld = resolve; });
  const latestRequest = new Promise<PlannerToday>((resolve) => { resolveLatest = resolve; });
  const getPlannerToday = jest.fn()
    .mockReturnValueOnce(oldRequest)
    .mockReturnValueOnce(latestRequest);
  const api = { getPlannerToday } as unknown as ApiClient;
  const { result } = renderHook(() => usePlannerDaily(api, '2026-07-17', true));
  await waitFor(() => expect(getPlannerToday).toHaveBeenCalledTimes(1));

  act(() => { void result.current.refresh(); });
  await waitFor(() => expect(getPlannerToday).toHaveBeenCalledTimes(2));

  const latest = { ...daily, reviewSessionIds: ['latest'] };
  const old = { ...daily, reviewSessionIds: ['old'] };
  await act(async () => { resolveLatest(latest); await latestRequest; });
  await act(async () => { resolveOld(old); await oldRequest; });

  expect(usePlannerStore.getState().dailyByDate['2026-07-17']).toBe(latest);
  expect(usePlannerStore.getState().loading['daily:2026-07-17']).toBe(false);
});

test('화면이 비활성화된 뒤 도착한 daily 응답은 store에 쓰지 않는다', async () => {
  let resolveRequest!: (value: PlannerToday) => void;
  const request = new Promise<PlannerToday>((resolve) => { resolveRequest = resolve; });
  const getPlannerToday = jest.fn().mockReturnValue(request);
  const api = { getPlannerToday } as unknown as ApiClient;
  const { rerender } = renderHook(
    ({ enabled }: { enabled: boolean }) => usePlannerDaily(api, '2026-07-17', enabled),
    { initialProps: { enabled: true } },
  );
  await waitFor(() => expect(getPlannerToday).toHaveBeenCalledTimes(1));

  rerender({ enabled: false });
  await act(async () => { resolveRequest(daily); await request; });

  expect(usePlannerStore.getState().dailyByDate['2026-07-17']).toBeUndefined();
});

test('폴더 새로고침은 먼저 시작한 하위 폴더 페이지 응답을 폐기한다', async () => {
  let resolveOlder!: (value: { items: PlannerFolderDetail['folder'][]; nextCursor: string | null }) => void;
  const olderRequest = new Promise<{ items: PlannerFolderDetail['folder'][]; nextCursor: string | null }>(
    (resolve) => { resolveOlder = resolve; },
  );
  const initial = plannerFolderDetail('older');
  const current = plannerFolderDetail(null);
  current.subfolders.items = [catalogFolder('fresh', '최신 폴더', 'fresh-page')];
  const api = {
    getPlannerFolder: jest.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(current),
    getPlannerFolderSubfolders: jest.fn(() => olderRequest),
  } as unknown as ApiClient;
  const { result } = renderHook(() => usePlannerFolderDetail(api, 'folder-1'));
  await waitFor(() => expect(result.current.subfolders?.nextCursor).toBe('older'));

  act(() => { void result.current.loadMoreSubfolders(); });
  await waitFor(() => expect(api.getPlannerFolderSubfolders).toHaveBeenCalledTimes(1));
  await act(async () => { await result.current.refresh(); });
  await act(async () => {
    resolveOlder({ items: [catalogFolder('stale', '오래된 폴더', null)], nextCursor: null });
    await olderRequest;
  });

  expect(result.current.subfolders?.items.map((item) => item.id)).toEqual(['fresh']);
});

test('별표 목록 끝 드롭은 다음 cursor 첫 ID 앞에 저장하고 성공 후 첫 페이지를 다시 읽는다', async () => {
  const firstPage = { items: [plannerFolder('a', 'A'), plannerFolder('b', 'B')], nextCursor: 'cursor-2' };
  const boundaryPage = { items: [plannerFolder('c', 'C')], nextCursor: null };
  const savedPage = { items: [plannerFolder('b', 'B'), plannerFolder('a', 'A')], nextCursor: 'cursor-2' };
  const api = {
    getStarredFolders: jest.fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(boundaryPage)
      .mockResolvedValueOnce(savedPage),
    moveStarredFolderOrder: jest.fn().mockResolvedValue({ ok: true }),
  } as unknown as ApiClient;
  const { result } = renderHook(() => usePlannerStarred(api));
  await waitFor(() => expect(result.current.data.items.map((folder) => folder.page.id)).toEqual(['a', 'b']));

  await act(async () => { await result.current.moveFolderOrder('a', null); });

  expect(api.getStarredFolders).toHaveBeenNthCalledWith(2, 'cursor-2');
  expect(api.moveStarredFolderOrder).toHaveBeenCalledWith('a', 'c');
  expect((api.getStarredFolders as jest.Mock).mock.calls[2]).toEqual([]);
  expect(result.current.data.items.map((folder) => folder.page.id)).toEqual(['b', 'a']);
});

test('저장 후 첫 페이지 재조회 실패는 공유 cursor를 지우고 모든 consumer의 loadMore를 막는다', async () => {
  const firstPage = { items: [plannerFolder('a', 'A'), plannerFolder('b', 'B')], nextCursor: 'old-cursor' };
  const refreshedPage = { items: [plannerFolder('b', 'B'), plannerFolder('a', 'A')], nextCursor: 'new-cursor' };
  const nextPage = { items: [plannerFolder('c', 'C')], nextCursor: null };
  const api = {
    getStarredFolders: jest.fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(firstPage)
      .mockRejectedValueOnce(new Error('첫 페이지 조회 실패'))
      .mockResolvedValueOnce(refreshedPage)
      .mockResolvedValueOnce(nextPage),
    moveStarredFolderOrder: jest.fn().mockResolvedValue({ ok: true }),
  } as unknown as ApiClient;
  const { result } = renderHook(() => usePlannerStarred(api));
  await waitFor(() => expect(result.current.data.items.map((folder) => folder.page.id)).toEqual(['a', 'b']));
  const { result: otherConsumer } = renderHook(() => usePlannerStarred(api));
  await waitFor(() => expect(otherConsumer.current.data.items.map((folder) => folder.page.id)).toEqual(['a', 'b']));
  await waitFor(() => expect(api.getStarredFolders).toHaveBeenCalledTimes(2));

  await act(async () => {
    await expect(result.current.moveFolderOrder('b', 'a')).rejects.toThrow('첫 페이지 조회 실패');
  });
  expect(result.current.data.items.map((folder) => folder.page.id)).toEqual(['b', 'a']);
  expect(result.current.refreshRequired).toBe(true);
  expect(usePlannerStore.getState().starred.nextCursor).toBeNull();

  await act(async () => { await otherConsumer.current.loadMore(); });
  expect(api.getStarredFolders).toHaveBeenCalledTimes(3);
  expect(api.getStarredFolders).not.toHaveBeenCalledWith('old-cursor');

  await act(async () => { await otherConsumer.current.refresh(); });
  expect(result.current.refreshRequired).toBe(false);
  await act(async () => { await result.current.loadMore(); });
  expect(api.getStarredFolders).toHaveBeenLastCalledWith('new-cursor');
});

test('page_updated 재조회가 성공하면 이전 저장 재조회 응답은 실패로 처리하지 않는다', async () => {
  const firstPage = { items: [plannerFolder('a', 'A'), plannerFolder('b', 'B')], nextCursor: 'old-cursor' };
  const supersededPage = { items: [plannerFolder('a', 'A'), plannerFolder('b', 'B')], nextCursor: 'old-cursor' };
  const updatedPage = { items: [plannerFolder('b', 'B'), plannerFolder('a', 'A')], nextCursor: 'new-cursor' };
  let resolveSaveRefresh!: (page: typeof firstPage) => void;
  let resolveInvalidationRefresh!: (page: typeof firstPage) => void;
  const saveRefresh = new Promise<typeof firstPage>((resolve) => { resolveSaveRefresh = resolve; });
  const invalidationRefresh = new Promise<typeof firstPage>((resolve) => { resolveInvalidationRefresh = resolve; });
  const api = {
    getStarredFolders: jest.fn()
      .mockResolvedValueOnce(firstPage)
      .mockReturnValueOnce(saveRefresh)
      .mockReturnValueOnce(invalidationRefresh),
    moveStarredFolderOrder: jest.fn().mockResolvedValue({ ok: true }),
  } as unknown as ApiClient;
  const { result } = renderHook(() => usePlannerStarred(api));
  await waitFor(() => expect(result.current.data.items.map((folder) => folder.page.id)).toEqual(['a', 'b']));

  let moveOutcome: unknown;
  let move!: Promise<void>;
  act(() => {
    move = result.current.moveFolderOrder('b', 'a').then(
      () => { moveOutcome = undefined; },
      (cause: unknown) => { moveOutcome = cause; },
    );
  });
  await waitFor(() => expect(api.getStarredFolders).toHaveBeenCalledTimes(2));
  act(() => usePlannerStore.getState().invalidate('page'));
  await waitFor(() => expect(api.getStarredFolders).toHaveBeenCalledTimes(3));

  await act(async () => {
    resolveInvalidationRefresh(updatedPage);
    await invalidationRefresh;
  });
  expect(result.current.data.nextCursor).toBe('new-cursor');
  expect(result.current.refreshRequired).toBe(false);

  await act(async () => {
    resolveSaveRefresh(supersededPage);
    await saveRefresh;
    await move;
  });

  expect(moveOutcome).toBeUndefined();
  expect(result.current.data.items.map((folder) => folder.page.id)).toEqual(['b', 'a']);
  expect(result.current.data.nextCursor).toBe('new-cursor');
  expect(result.current.refreshRequired).toBe(false);
  expect(result.current.error).toBeNull();
});

test('경계 조회 중 업무 내용 갱신은 낙관 이동과 실패 복구에서 보존한다', async () => {
  const firstPage = { items: [plannerFolder('a', 'A'), plannerFolder('b', 'B')], nextCursor: 'cursor-2' };
  const latestPage = {
    items: [plannerFolder('a', 'A'), plannerFolder('b', '최신 B')],
    nextCursor: 'cursor-2',
  };
  const boundaryPage = { items: [plannerFolder('c', 'C')], nextCursor: null };
  let resolveBoundary!: (page: typeof boundaryPage) => void;
  let rejectMove!: (cause: Error) => void;
  let resolveRefresh!: (page: typeof latestPage) => void;
  const boundaryRequest = new Promise<typeof boundaryPage>((resolve) => { resolveBoundary = resolve; });
  const mutation = new Promise<void>((_resolve, reject) => { rejectMove = reject; });
  const refreshRequest = new Promise<typeof latestPage>((resolve) => { resolveRefresh = resolve; });
  const api = {
    getStarredFolders: jest.fn()
      .mockResolvedValueOnce(firstPage)
      .mockReturnValueOnce(boundaryRequest)
      .mockReturnValueOnce(refreshRequest),
    moveStarredFolderOrder: jest.fn().mockReturnValue(mutation),
  } as unknown as ApiClient;
  const { result } = renderHook(() => usePlannerStarred(api));
  await waitFor(() => expect(result.current.data.items).toHaveLength(2));

  let move!: Promise<unknown>;
  act(() => {
    move = result.current.moveFolderOrder('a', null).catch((cause: unknown) => cause);
  });
  await waitFor(() => expect(api.getStarredFolders).toHaveBeenCalledTimes(2));
  act(() => usePlannerStore.getState().setStarred(latestPage, 'replace'));
  await act(async () => { resolveBoundary(boundaryPage); await boundaryRequest; });
  await waitFor(() => expect(api.moveStarredFolderOrder).toHaveBeenCalledWith('a', 'c'));

  expect(result.current.data.items.map((folder) => folder.page.id)).toEqual(['b', 'a']);
  expect(result.current.data.items[0].page.title).toBe('최신 B');

  act(() => { rejectMove(new Error('HTTP 409')); });
  await waitFor(() => expect(api.getStarredFolders).toHaveBeenCalledTimes(3));
  expect(result.current.data.items.map((folder) => folder.page.id)).toEqual(['a', 'b']);
  expect(result.current.data.items[1].page.title).toBe('최신 B');

  await act(async () => { resolveRefresh(latestPage); await move; });
  expect(result.current.data.items[1].page.title).toBe('최신 B');
});

test.each([
  ['빈 다음 페이지', { items: [], nextCursor: null }],
  ['이미 로딩된 항목이 포함된 다음 페이지', {
    items: [plannerFolder('b', '중복'), plannerFolder('c', 'C')], nextCursor: null,
  }],
])('%s이면 전체 끝으로 대체하지 않고 재조회한다', async (_label, boundaryPage) => {
  const firstPage = { items: [plannerFolder('a', 'A'), plannerFolder('b', 'B')], nextCursor: 'cursor-2' };
  const api = {
    getStarredFolders: jest.fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(boundaryPage)
      .mockResolvedValueOnce(firstPage),
    moveStarredFolderOrder: jest.fn().mockResolvedValue({ ok: true }),
  } as unknown as ApiClient;
  const { result } = renderHook(() => usePlannerStarred(api));
  await waitFor(() => expect(result.current.data.items).toHaveLength(2));

  await act(async () => {
    await expect(result.current.moveFolderOrder('a', null)).rejects.toThrow();
  });

  expect(api.moveStarredFolderOrder).not.toHaveBeenCalled();
  expect((api.getStarredFolders as jest.Mock).mock.calls[2]).toEqual([]);
  expect(result.current.data.items.map((folder) => folder.page.id)).toEqual(['a', 'b']);
});

test('경계 cursor 조회 실패는 저장하지 않고 첫 페이지부터 재조회한다', async () => {
  const firstPage = { items: [plannerFolder('a', 'A'), plannerFolder('b', 'B')], nextCursor: 'cursor-2' };
  const api = {
    getStarredFolders: jest.fn()
      .mockResolvedValueOnce(firstPage)
      .mockRejectedValueOnce(new Error('경계 조회 실패'))
      .mockResolvedValueOnce(firstPage),
    moveStarredFolderOrder: jest.fn().mockResolvedValue({ ok: true }),
  } as unknown as ApiClient;
  const { result } = renderHook(() => usePlannerStarred(api));
  await waitFor(() => expect(result.current.data.items).toHaveLength(2));

  await act(async () => {
    await expect(result.current.moveFolderOrder('a', null)).rejects.toThrow('경계 조회 실패');
  });

  expect(api.moveStarredFolderOrder).not.toHaveBeenCalled();
  expect(api.getStarredFolders).toHaveBeenNthCalledWith(2, 'cursor-2');
  expect((api.getStarredFolders as jest.Mock).mock.calls[2]).toEqual([]);
  expect(result.current.data.items.map((folder) => folder.page.id)).toEqual(['a', 'b']);
});

test('미로딩 before target은 경계 검증 없이는 저장하지 않고 재조회한다', async () => {
  const firstPage = { items: [plannerFolder('a', 'A'), plannerFolder('b', 'B')], nextCursor: null };
  const api = {
    getStarredFolders: jest.fn().mockResolvedValue(firstPage),
    moveStarredFolderOrder: jest.fn().mockResolvedValue({ ok: true }),
  } as unknown as ApiClient;
  const { result } = renderHook(() => usePlannerStarred(api));
  await waitFor(() => expect(result.current.data.items).toHaveLength(2));

  await act(async () => {
    await expect(result.current.moveFolderOrder('a', 'not-loaded')).rejects.toThrow();
  });

  expect(api.moveStarredFolderOrder).not.toHaveBeenCalled();
  expect(result.current.data.items.map((folder) => folder.page.id)).toEqual(['a', 'b']);
});

test('경계 cursor에서 중복 source는 저장하지 않고 첫 페이지를 재조회한다', async () => {
  const firstPage = { items: [plannerFolder('a', 'A'), plannerFolder('b', 'B')], nextCursor: 'cursor-2' };
  const api = {
    getStarredFolders: jest.fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce({ items: [plannerFolder('b', '중복 source')], nextCursor: null })
      .mockResolvedValueOnce(firstPage),
    moveStarredFolderOrder: jest.fn().mockResolvedValue({ ok: true }),
  } as unknown as ApiClient;
  const { result } = renderHook(() => usePlannerStarred(api));
  await waitFor(() => expect(result.current.data.items).toHaveLength(2));

  await act(async () => {
    await expect(result.current.moveFolderOrder('b', null)).rejects.toThrow();
  });

  expect(api.moveStarredFolderOrder).not.toHaveBeenCalled();
  expect(api.moveStarredFolderOrder).not.toHaveBeenCalledWith('b', null);
  expect((api.getStarredFolders as jest.Mock).mock.calls[2]).toEqual([]);
});

test('별표 순서 저장이 409로 실패하면 낙관적 순서를 되돌리고 재조회한다', async () => {
  const firstPage = { items: [plannerFolder('a', 'A'), plannerFolder('b', 'B')], nextCursor: null };
  let resolveRefresh!: (value: typeof firstPage) => void;
  let rejectMove!: (cause: Error) => void;
  const refresh = new Promise<typeof firstPage>((resolve) => { resolveRefresh = resolve; });
  const mutation = new Promise<void>((_resolve, reject) => { rejectMove = reject; });
  const api = {
    getStarredFolders: jest.fn().mockResolvedValueOnce(firstPage).mockReturnValueOnce(refresh),
    moveStarredFolderOrder: jest.fn().mockReturnValue(mutation),
  } as unknown as ApiClient;
  const { result } = renderHook(() => usePlannerStarred(api));
  await waitFor(() => expect(result.current.data.items).toHaveLength(2));

  let move!: Promise<unknown>;
  act(() => {
    move = result.current.moveFolderOrder('b', 'a').catch((cause: unknown) => cause);
  });
  await waitFor(() => expect(api.moveStarredFolderOrder).toHaveBeenCalledTimes(1));
  expect(result.current.data.items.map((folder) => folder.page.id)).toEqual(['b', 'a']);

  act(() => { rejectMove(new Error('HTTP 409')); });
  await waitFor(() => expect(api.getStarredFolders).toHaveBeenCalledTimes(2));
  expect(result.current.data.items.map((folder) => folder.page.id)).toEqual(['a', 'b']);

  await act(async () => { resolveRefresh(firstPage); await move; });
  expect(await move).toMatchObject({ message: 'HTTP 409' });
  expect(result.current.data.items.map((folder) => folder.page.id)).toEqual(['a', 'b']);
  expect(result.current.error).toBe('HTTP 409');
  expect(result.current.refreshRequired).toBe(false);
});

test('page invalidation은 열린 페이지를 재조회하고 늦은 응답을 폐기한다', async () => {
  let resolveOlder!: (value: any) => void;
  let resolveLatest!: (value: any) => void;
  const older = new Promise<any>((resolve) => { resolveOlder = resolve; });
  const latest = new Promise<any>((resolve) => { resolveLatest = resolve; });
  const getPage = jest.fn().mockReturnValueOnce(older).mockReturnValueOnce(latest);
  const api = { getPage } as unknown as ApiClient;
  const { result } = renderHook(() => usePlannerPageDetail(api, 'task-1'));
  await waitFor(() => expect(getPage).toHaveBeenCalledTimes(1));

  act(() => usePlannerStore.getState().invalidate('page'));
  await waitFor(() => expect(getPage).toHaveBeenCalledTimes(2));
  const latestResult = pageRead('최신 내용');
  await act(async () => { resolveLatest(latestResult); await latest; });
  await act(async () => { resolveOlder(pageRead('오래된 내용')); await older; });

  expect(result.current.data).toBe(latestResult);
});

test('같은 pageId라도 auth generation이 바뀌면 이전 data를 즉시 숨기고 새 실패에도 복원하지 않는다', async () => {
  let rejectScopeB!: (cause: unknown) => void;
  const scopeBRequest = new Promise<never>((_resolve, reject) => { rejectScopeB = reject; });
  const api = {
    getPage: jest.fn()
      .mockResolvedValueOnce(pageRead('A 계정 문서'))
      .mockReturnValueOnce(scopeBRequest),
  } as unknown as ApiClient;
  const { result } = renderHook(() => usePlannerPageDetail(api, 'task-1'));
  await waitFor(() => expect(result.current.data?.page.title).toBe('A 계정 문서'));

  await act(async () => {
    useAuthStore.getState().setJwt('scope-b');
    await Promise.resolve();
  });
  expect(result.current.data).toBeUndefined();
  await waitFor(() => expect(result.current.loading).toBe(true));
  await act(async () => {
    rejectScopeB(new Error('B 계정 조회 실패'));
    await scopeBRequest.catch(() => undefined);
  });
  expect(result.current.data).toBeUndefined();
  expect(result.current.error).toBe('B 계정 조회 실패');
  expect(result.current.loading).toBe(false);
});

function plannerFolder(id: string, title: string): PlannerFolder {
  return {
    page: {
      id, title, dailyDate: null, version: 1, archived: false,
      metadata: {}, createdAt: '', updatedAt: '',
    },
    blocks: [], folderId: id, folderSummary: null, status: 'open', assignee: '',
    contextCount: 0, progress: null, projectPageId: 'project', sessions: [],
    sessionIds: [],
  };
}

function plannerFolderDetail(nextCursor: string | null): PlannerFolderDetail {
  return {
    folder: catalogFolder('folder-1', '폴더', 'page-1'),
    page: plannerFolder('page-1', '폴더').page,
    blocks: [],
    cards: [],
    subfolders: { items: [], nextCursor },
    sessions: { items: [], nextCursor: null },
  };
}

function catalogFolder(id: string, name: string, projectPageId: string | null): CatalogFolder {
  return {
    id, name, projectPageId, sortOrder: 0, parentFolderId: null, settings: {},
    archived: false, status: 'open', version: 1,
  };
}

function pageRead(title: string) {
  return {
    page: {
      id: 'task-1', title, dailyDate: null, version: 1, archived: false,
      metadata: {}, createdAt: '', updatedAt: '',
    },
    blocks: [],
    stateVector: 'AQID',
  };
}
