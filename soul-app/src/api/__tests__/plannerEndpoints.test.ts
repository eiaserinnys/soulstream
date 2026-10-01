import { createApiClient } from '../client';
import { useAuthStore } from '../../store/authStore';

const BASE = 'https://planner.test';
const page = (id: string) => ({
  id, title: id, daily_date: null, version: 1, archived: false, metadata: {},
  created_at: '2026-07-17T00:00:00Z', updated_at: '2026-07-17T00:00:00Z',
});
const folder = (id: string) => ({
  id, name: id, sortOrder: 0, parentFolderId: null, projectPageId: `${id}-page`,
  settings: {}, archived: false, status: 'open', version: 1,
});
const plannerFolder = (id: string) => ({
  folder: folder(id), page: page(`${id}-page`), itemCounts: { pending: 1 },
  itemTotal: 1, completedItemCount: 0, assignee: null,
});
const slice = <T,>(items: T[], nextCursor: string | null = null) => ({ items, nextCursor });
const detail = {
  folder: folder('folder-1'), page: page('folder-1-page'), blocks: [], cards: [],
  subfolders: slice([folder('child')], 'next-child'),
  sessions: slice([{ agentSessionId: 'session-1', folderId: 'folder-1', displayName: '실행 세션',
    nodeId: 'node-1', sessionType: 'agent', status: 'running', agentId: 'roselin',
    modelPreset: 'sol', reasoningEffort: 'high', callerSessionId: 'caller-1',
    predecessorSessionId: null, reviewState: 'not_required', eventCount: 4,
    createdAt: '', updatedAt: '' }]),
};

function response(body: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

beforeEach(() => useAuthStore.setState({ jwt: 'planner-jwt' }));
afterEach(() => jest.restoreAllMocks());

test('오늘·별표·폴더 상세와 커서 조회가 새 경로를 사용한다', async () => {
  const payloads = [
    { daily: { page: { ...page('daily'), daily_date: '2026-07-17' }, blocks: [], state_vector: 'sv' },
      folders: [plannerFolder('folder-1')], memoBlocks: [], attention: [], running: [], queued: [], reviewSessionIds: [] },
    slice([plannerFolder('folder-1')], 'star-next'),
    { dates: ['2026-07-16'] },
    detail,
    slice([folder('child')]),
    slice([{ agentSessionId: 'session-1', status: 'running', eventCount: 4 }]),
  ];
  const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () => response(payloads.shift()));
  const api = createApiClient(BASE);
  const today = await api.getPlannerToday('2026-07-17');
  await api.getStarredFolders('cursor a');
  await api.getDailyHistory('2026-07-17');
  const workspace = await api.getPlannerFolder('folder/1');
  await api.getPlannerFolderSubfolders('folder/1', 'child cursor');
  const sessions = await api.getPlannerFolderSessions('folder/1', 'session cursor');
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
    `${BASE}/api/planner/today?date=2026-07-17`,
    `${BASE}/api/planner/starred-folders?cursor=cursor+a`,
    `${BASE}/api/planner/daily-history?before=2026-07-17`,
    `${BASE}/api/planner/folders/folder%2F1`,
    `${BASE}/api/planner/folders/folder%2F1/subfolders?cursor=child+cursor`,
    `${BASE}/api/planner/folders/folder%2F1/sessions?cursor=session+cursor`,
  ]);
  for (const [, init] of fetchMock.mock.calls) {
    expect(((init as RequestInit).headers as Headers).get('Authorization')).toBe('Bearer planner-jwt');
  }
  expect(today.folders[0]).toMatchObject({ folderId: 'folder-1', folderSummary: { id: 'folder-1' } });
  expect(workspace).toMatchObject({ folder: { id: 'folder-1' }, subfolders: { nextCursor: 'next-child' } });
  expect(workspace).not.toHaveProperty('documents');
  expect(workspace.sessions.items[0]).toMatchObject({
    agentSessionId: 'session-1', folderId: 'folder-1', displayName: '실행 세션',
    modelPreset: 'sol', reasoningEffort: 'high', callerSessionId: 'caller-1', eventCount: 4,
  });
  expect(sessions.items).toEqual([{ agentSessionId: 'session-1' }]);
});

test('별표 순서 저장은 page ID를 camelCase body로 보낸다', async () => {
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(response({ ok: true }));
  await createApiClient(BASE).moveStarredFolderOrder('page/source', null);
  expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/planner/starred-folders/order`);
  const init = fetchMock.mock.calls[0][1] as RequestInit;
  expect(init.method).toBe('PATCH');
  expect(init.body).toBe(JSON.stringify({ pageId: 'page/source', beforePageId: null }));
});

test('폴더 ID가 빠진 planner 응답은 읽기 경계에서 실패한다', async () => {
  jest.spyOn(global, 'fetch').mockResolvedValue(response({
    daily: { page: page('daily'), blocks: [], state_vector: 'sv' },
    folders: [{ ...plannerFolder('folder-1'), folder: { ...folder('folder-1'), id: '' } }],
    memoBlocks: [], attention: [], running: [], queued: [], reviewSessionIds: [],
  }));
  await expect(createApiClient(BASE).getPlannerToday('2026-07-17')).rejects.toThrow();
});
