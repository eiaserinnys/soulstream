import { createApiClient } from '../client';
import { useAuthStore } from '../../store/authStore';

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; jest.restoreAllMocks(); });
test('authenticated dismiss encodes session/key and returns the authoritative empty report', async () => {
  useAuthStore.setState({ jwt: 'public-test-token', authRejected: false });
  const result = { ok: true, changed: true, entries: [], persistent_report: [] };
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => result, headers: new Headers({ 'Content-Type': 'application/json' }) });
  const saved = await createApiClient('https://public.test').dismissPersistentReport('pas/one', 'report one');
  expect(saved).toEqual(result);
  const [url, init] = jest.mocked(global.fetch).mock.calls[0];
  expect(url).toBe('https://public.test/api/persistent-sessions/pas%2Fone/reports/report%20one');
  expect(init?.method).toBe('DELETE');
  expect((init?.headers as Headers).get('Authorization')).toBe('Bearer public-test-token');
});
test('intervene preserves attachments and sends report context under context_items', async () => {
  useAuthStore.setState({ jwt: null, authRejected: false });
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ delivered: true }), headers: new Headers({ 'Content-Type': 'application/json' }) });
  const context = [{ key: 'persistent_report_reply', content: { key: 'report', option: '응' } }];
  await createApiClient('https://public.test').intervene('pas', '제목: 응', ['/public/a.png'], context);
  const body = JSON.parse(jest.mocked(global.fetch).mock.calls[0][1]!.body as string);
  expect(body.context_items).toEqual(context);
  expect(body.attachmentPaths).toEqual(['/public/a.png']);
  expect(body.text).toContain('제목: 응');
});
