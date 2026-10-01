import { cardFixture } from '../../test-support/cards';
import { createApiClient } from '../client';
import { useAuthStore } from '../../store/authStore';

const BASE = 'https://planner.test';
function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, statusText: status === 404 ? 'Not Found' : 'OK',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

beforeEach(() => useAuthStore.setState({ jwt: 'planner-jwt' }));
afterEach(() => jest.restoreAllMocks());

test('폴더 snapshot의 카드를 camelCase로 읽는다', async () => {
  const snapshot = {
    folder: { id: 'folder-1', name: '업무', sortOrder: 0, parentFolderId: null,
      projectPageId: 'page-1', settings: {}, archived: false,
      status: 'open', version: 1 },
    cards: [cardFixture({ id: 'card-1', status: 'done', version: 3 })],
  };
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(response(snapshot));
  await expect(createApiClient(BASE).getFolderSnapshot('folder/1')).resolves.toEqual(snapshot);
  expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/folders/folder%2F1`);
  expect((fetchMock.mock.calls[0][1]?.headers as Headers).get('Authorization')).toBe('Bearer planner-jwt');
});

test('하위 폴더는 cursor로 조회한다', async () => {
  const payload = { items: [{ id: 'child' }], nextCursor: 'next' };
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(response(payload));
  await expect(createApiClient(BASE).getChildFolders('parent/1', 'cursor a')).resolves.toEqual(payload);
  expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/folders/parent%2F1/children?cursor=cursor+a`);
});

test('폴더 생성은 체크리스트 설정 없이 요청한다', async () => {
  const result = { folder: { id: 'child', version: 1 }, operation: { id: 'op' }, idempotent: false };
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(response(result, 201));
  await createApiClient(BASE).createFolder({
    name: '새 폴더', parentFolderId: 'parent',
    initialContext: { guidance: '지침', atomReferences: [] }, idempotencyKey: 'request-1',
  });
  expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/folders`);
  expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
    name: '새 폴더', parentFolderId: 'parent',
    initialContext: { guidance: '지침', atomReferences: [] }, idempotencyKey: 'request-1',
  });
});
