import { createApiClient } from '../client';

test('catalog 폴더의 projectPageId를 손실 없이 보존한다', async () => {
  jest.spyOn(global, 'fetch').mockImplementation(async (url) => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: async () => new URL(String(url)).pathname === '/api/folders'
      ? { folders: [{ id: 'folder-1', name: 'Project', sortOrder: 0, projectPageId: 'page-1' }] }
      : { sessions: [], total: 0 },
    text: async () => '',
  }) as Response);

  const catalog = await createApiClient('https://catalog.test').getCatalog();

  expect(catalog.folders[0].projectPageId).toBe('page-1');
});
