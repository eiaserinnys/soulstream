import { createApiClient } from '../client';
import { useAuthStore } from '../../store/authStore';

const BASE = 'https://mutation.test';
function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status,
    statusText: status === 409 ? 'Conflict' : 'OK',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: async () => body, text: async () => JSON.stringify(body) } as Response;
}
const mutation = { folder: { id: 'folder-1', version: 8, status: 'open' },
  operation: { id: 'op-1', folderId: 'folder-1', operationType: 'set_folder_status' },
  idempotent: false };

beforeEach(() => useAuthStore.setState({ jwt: 'mutation-jwt', authRejected: false }));
afterEach(() => jest.restoreAllMocks());

test('폴더 완료·보관은 version과 멱등 키를 보낸다', async () => {
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(response(mutation));
  const api = createApiClient(BASE);
  await api.setFolderStatus('folder/1', 'completed', 8, 'status-1');
  await api.archiveFolder('folder/1', 9, 'archive-1');
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
    `${BASE}/api/folders/folder%2F1/status`,
    `${BASE}/api/folders/folder%2F1/archive`,
  ]);
  expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)))).toEqual([
    { status: 'completed', expectedVersion: 8, idempotencyKey: 'status-1' },
    { expectedVersion: 9, idempotencyKey: 'archive-1' },
  ]);
  for (const [, init] of fetchMock.mock.calls) {
    expect(((init as RequestInit).headers as Headers).get('Authorization')).toBe('Bearer mutation-jwt');
  }
});

test('폴더 이동은 parentFolderId를 단일 identity owner에 보낸다', async () => {
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(response(mutation));
  await createApiClient(BASE).updateFolder('folder-1', {
    parentFolderId: 'parent-2', expectedVersion: 7, idempotencyKey: 'move-1',
  });
  expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/folders/folder-1`);
  expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('PUT');
  expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({
    parentFolderId: 'parent-2', expectedVersion: 7, idempotencyKey: 'move-1',
  });
});

test('세션 생성은 folderId 하나와 page anchor를 보낸다', async () => {
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(response({ agentSessionId: 'session-new' }));
  await createApiClient(BASE).createSession({
    prompt: '계속', folderId: 'folder-1', modelPreset: 'preset',
    pageAnchor: { pageId: 'page-1', blockId: 'anchor-1', expectedVersion: 9 },
    predecessorSessionId: 'session-0',
  });
  const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
  expect(body).toMatchObject({ folderId: 'folder-1', model_preset: 'preset',
    predecessor_session_id: 'session-0', pageAnchor: { pageId: 'page-1', blockId: 'anchor-1' } });
  expect(body).not.toHaveProperty('container');
});

test('폴더 상태 변경 401은 인증을 해제하고 409는 그대로 노출한다', async () => {
  const fetchMock = jest.spyOn(global, 'fetch');
  fetchMock.mockResolvedValueOnce(response({ detail: 'unauthorized' }, 401));
  await expect(createApiClient(BASE).setFolderStatus('folder-1', 'completed', 7, 'status-1'))
    .rejects.toMatchObject({ status: 401 });
  expect(useAuthStore.getState().jwt).toBeNull();
  useAuthStore.setState({ jwt: 'mutation-jwt', authRejected: false });
  fetchMock.mockResolvedValueOnce(response({ detail: 'version conflict' }, 409));
  await expect(createApiClient(BASE).setFolderStatus('folder-1', 'completed', 7, 'status-2'))
    .rejects.toMatchObject({ status: 409 });
  expect(useAuthStore.getState().jwt).toBe('mutation-jwt');
});
