import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ApiClient } from '../../api/client';
import type { PlannerFolder } from '../../api/plannerTypes';
import { resetAuthScopeForTest } from '../../lib/auth-scope';
import { useAuthStore } from '../../store/authStore';
import { usePlannerStore } from '../../store/plannerStore';
import { useSettingsStore } from '../../store/settingsStore';
import { usePlannerStarred } from '../usePlannerStarred';

type StarredPage = { items: PlannerFolder[]; nextCursor: string | null };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function folder(id: string, title = id): PlannerFolder {
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

function page(ids: string[], nextCursor: string | null = null, titlePrefix = ''): StarredPage {
  return { items: ids.map((id) => folder(id, `${titlePrefix}${id}`)), nextCursor };
}

beforeEach(() => {
  useSettingsStore.setState({ serverUrl: 'https://planner.test' });
  useAuthStore.setState({ jwt: 'scope-a' });
  resetAuthScopeForTest();
  usePlannerStore.getState().resetForTest();
});

test('unmount 뒤 진행 중인 별표 순서 응답은 store를 다시 읽거나 변경하지 않는다', async () => {
  const firstPage = page(['a', 'b']);
  const mutation = deferred<{ ok: true }>();
  const api = {
    getStarredFolders: jest.fn().mockResolvedValue(firstPage),
    moveStarredFolderOrder: jest.fn().mockReturnValue(mutation.promise),
  } as unknown as ApiClient;
  const { result, unmount } = renderHook(() => usePlannerStarred(api));
  await waitFor(() => expect(result.current.data.items.map((item) => item.page.id)).toEqual(['a', 'b']));

  let move!: Promise<unknown>;
  act(() => { move = result.current.moveFolderOrder('b', 'a').catch((cause: unknown) => cause); });
  await waitFor(() => expect(api.moveStarredFolderOrder).toHaveBeenCalledTimes(1));
  unmount();
  await act(async () => { mutation.resolve({ ok: true }); await move; });

  expect(api.getStarredFolders).toHaveBeenCalledTimes(1);
  expect(usePlannerStore.getState().starred.items.map((item) => item.page.id)).toEqual(['b', 'a']);
  expect(usePlannerStore.getState().error.starred).toBeNull();
});

test('page_updated 재조회 실패 뒤 저장 재조회가 늦게 와도 오류와 cursor 차단을 유지한다', async () => {
  const initialPage = page(['a', 'b'], 'old-cursor');
  const saveRefresh = deferred<StarredPage>();
  const invalidationRefresh = deferred<StarredPage>();
  const api = {
    getStarredFolders: jest.fn()
      .mockResolvedValueOnce(initialPage)
      .mockReturnValueOnce(saveRefresh.promise)
      .mockReturnValueOnce(invalidationRefresh.promise),
    moveStarredFolderOrder: jest.fn().mockResolvedValue({ ok: true }),
  } as unknown as ApiClient;
  const { result } = renderHook(() => usePlannerStarred(api));
  await waitFor(() => expect(result.current.data.items.map((item) => item.page.id)).toEqual(['a', 'b']));

  let outcome: unknown;
  let move!: Promise<void>;
  act(() => {
    move = result.current.moveFolderOrder('b', 'a').then(
      () => { outcome = undefined; },
      (cause: unknown) => { outcome = cause; },
    );
  });
  await waitFor(() => expect(api.getStarredFolders).toHaveBeenCalledTimes(2));
  act(() => usePlannerStore.getState().invalidate('page'));
  await waitFor(() => expect(api.getStarredFolders).toHaveBeenCalledTimes(3));

  await act(async () => {
    invalidationRefresh.reject(new Error('page_updated refresh failed'));
    await invalidationRefresh.promise.catch(() => undefined);
  });
  expect(result.current.data.nextCursor).toBeNull();
  expect(result.current.refreshRequired).toBe(true);
  expect(result.current.error).toBe('page_updated refresh failed');

  await act(async () => {
    saveRefresh.resolve(page(['a', 'b'], 'old-cursor'));
    await saveRefresh.promise;
    await move;
  });

  expect(outcome).toBeUndefined();
  expect(result.current.data.items.map((item) => item.page.id)).toEqual(['b', 'a']);
  expect(result.current.data.nextCursor).toBeNull();
  expect(result.current.refreshRequired).toBe(true);
  expect(result.current.error).toBe('page_updated refresh failed');
});

test('boundary, auth, server 전환 뒤 늦은 순서 응답은 새 planner store를 건드리지 않는다', async () => {
  const initialPage = page(['a', 'b'], 'cursor-2');
  const boundary = deferred<StarredPage>();
  const oldApi = {
    getStarredFolders: jest.fn((cursor?: string) => cursor ? boundary.promise : Promise.resolve(initialPage)),
    moveStarredFolderOrder: jest.fn(),
  } as unknown as ApiClient;

  let serverPage = page(['a', 'b'], null, 'server-');
  let jwtPage = page(['a', 'b'], null, 'jwt-');
  let urlPage = page(['url-only']);
  const serverMutationRequests: ReturnType<typeof deferred<{ ok: true }>>[] = [];
  const serverApi = {
    getStarredFolders: jest.fn().mockImplementation(() => Promise.resolve(serverPage)),
    moveStarredFolderOrder: jest.fn(() => {
      const request = deferred<{ ok: true }>();
      serverMutationRequests.push(request);
      return request.promise;
    }),
  } as unknown as ApiClient;
  const newServerApi = {
    getStarredFolders: jest.fn().mockResolvedValue(urlPage),
    moveStarredFolderOrder: jest.fn(),
  } as unknown as ApiClient;

  const { result, rerender } = renderHook(
    ({ api }: { api: ApiClient }) => usePlannerStarred(api),
    { initialProps: { api: oldApi } },
  );
  await waitFor(() => expect(result.current.data.items.map((item) => item.page.id)).toEqual(['a', 'b']));

  let boundaryMove!: Promise<unknown>;
  act(() => {
    boundaryMove = result.current.moveFolderOrder('a', null).catch((cause: unknown) => cause);
  });
  await waitFor(() => expect(oldApi.getStarredFolders).toHaveBeenCalledTimes(2));

  act(() => {
    useSettingsStore.setState({ serverUrl: 'https://planner-b.test' });
    rerender({ api: serverApi });
  });
  await waitFor(() => expect(result.current.data.items[0]?.page.title).toBe('server-a'));
  await act(async () => { boundary.resolve(page(['c'])); await boundaryMove; });
  expect(oldApi.moveStarredFolderOrder).not.toHaveBeenCalled();
  expect(usePlannerStore.getState().error.starred).toBeNull();

  serverPage = jwtPage;
  let successMove!: Promise<unknown>;
  act(() => {
    successMove = result.current.moveFolderOrder('b', 'a').catch((cause: unknown) => cause);
  });
  await waitFor(() => expect(serverApi.moveStarredFolderOrder).toHaveBeenCalledTimes(1));
  act(() => useAuthStore.getState().setJwt('scope-b'));
  await waitFor(() => expect(result.current.data.items[0]?.page.title).toBe('jwt-a'));
  await act(async () => { serverMutationRequests[0].resolve({ ok: true }); await successMove; });
  expect(await successMove).toBeUndefined();
  expect(serverApi.getStarredFolders).toHaveBeenCalledTimes(2);
  expect(usePlannerStore.getState().error.starred).toBeNull();

  let failedMove!: Promise<unknown>;
  act(() => {
    failedMove = result.current.moveFolderOrder('b', 'a').catch((cause: unknown) => cause);
  });
  await waitFor(() => expect(serverApi.moveStarredFolderOrder).toHaveBeenCalledTimes(2));
  act(() => {
    useSettingsStore.setState({ serverUrl: 'https://planner-c.test' });
    rerender({ api: newServerApi });
  });
  await waitFor(() => expect(result.current.data.items.map((item) => item.page.id)).toEqual(['url-only']));
  await act(async () => {
    serverMutationRequests[1].reject(new Error('이전 서버 저장 실패'));
    await failedMove;
  });

  expect(await failedMove).toBeUndefined();
  expect(newServerApi.getStarredFolders).toHaveBeenCalledTimes(1);
  expect(usePlannerStore.getState().starred.items.map((item) => item.page.id)).toEqual(['url-only']);
  expect(usePlannerStore.getState().error.starred).toBeNull();
  expect(usePlannerStore.getState().loading.starred).toBe(false);
});
