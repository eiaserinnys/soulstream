import { createApiClient } from '../client';
import { UI_EVENT_SCHEMA_VERSION } from '../uiEventsEndpoints';
import { useAuthStore } from '../../store/authStore';

const BASE = 'https://ui-events.example';

function response(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers({ 'Content-Type': 'application/json' }),
  } as Response;
}

beforeEach(() => {
  useAuthStore.setState({ jwt: 'ui-events-jwt' });
  (global as any).fetch = jest.fn()
    .mockResolvedValueOnce(response({
      enabled: true,
      flushIntervalMs: 10_000,
      maxBatchSize: 20,
      maxQueueSize: 500,
      schemaVersion: UI_EVENT_SCHEMA_VERSION,
    }))
    .mockResolvedValueOnce(response({ accepted: 1, duplicates: 0, rejected: [] }));
});

test('UI 이벤트 설정과 봉투는 전용 인증 API로만 전송한다', async () => {
  const api = createApiClient(BASE);

  await expect(api.getUiEventsConfig()).resolves.toMatchObject({ enabled: true });
  await expect(api.postUiEvents({
    schemaVersion: UI_EVENT_SCHEMA_VERSION,
    installId: 'install-1',
    clientSessionKey: 'run-1',
    appVersion: '1.0.0+51',
    events: [{
      eventId: 'event-1',
      seq: 1,
      occurredAt: '2026-09-21T00:00:00.000Z',
      type: 'view_open',
      target: { kind: 'session', id: 'session-1' },
      from: null,
      entry: 'feed',
      flowId: null,
      attrs: {},
    }],
  })).resolves.toEqual({ accepted: 1, duplicates: 0, rejected: [] });

  const calls = (global.fetch as jest.Mock).mock.calls;
  expect(calls[0][0]).toBe(`${BASE}/api/ui-events/config`);
  expect(calls[1][0]).toBe(`${BASE}/api/ui-events`);
  const init = calls[1][1] as RequestInit;
  expect(init.method).toBe('POST');
  expect((init.headers as Headers).get('Authorization')).toBe('Bearer ui-events-jwt');
  expect(JSON.parse(init.body as string)).toEqual(expect.objectContaining({
    schemaVersion: UI_EVENT_SCHEMA_VERSION,
    events: [expect.objectContaining({ type: 'view_open' })],
  }));
});
