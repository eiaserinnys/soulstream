import { ApiHttpError } from '../../api/clientCore';
import {
  UI_EVENT_SCHEMA_VERSION,
  UiUsageEvents,
} from '../ui-usage-events';

type Stored = Map<string, string>;

function storage(initial: Record<string, string> = {}) {
  const values: Stored = new Map(Object.entries(initial));
  return {
    getItem: jest.fn(async (key: string) => values.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: jest.fn(async (key: string) => {
      values.delete(key);
    }),
    value(key: string) {
      return values.get(key) ?? null;
    },
  };
}

const scope = {
  serverUrl: 'https://soul.example/',
  jwt: 'jwt',
  generation: 'scope-1',
};

function enabledConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    flushIntervalMs: 10_000,
    maxBatchSize: 20,
    maxQueueSize: 500,
    schemaVersion: UI_EVENT_SCHEMA_VERSION,
    ...overrides,
  };
}

function collectorFor(
  client: {
    getUiEventsConfig: jest.Mock;
    postUiEvents: jest.Mock;
  },
  store = storage(),
) {
  let serial = 0;
  return {
    store,
    collector: new UiUsageEvents({
      storage: store,
      createClient: () => client,
      isScopeCurrent: () => true,
      createUuid: () => `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`,
      now: () => new Date('2026-09-21T00:00:00.000Z'),
      autoFlush: false,
    }),
  };
}

afterEach(() => {
  jest.clearAllMocks();
});

test('원래 봉투를 보존해 보내고 compose 원문은 payload에 넣지 않는다', async () => {
  const client = {
    getUiEventsConfig: jest.fn().mockResolvedValue(enabledConfig()),
    postUiEvents: jest.fn().mockResolvedValue({
      accepted: 1,
      duplicates: 0,
      rejected: [],
    }),
  };
  const { collector } = collectorFor(client);
  await collector.start(scope, 'owner@example.com');

  collector.record({
    type: 'compose_submit',
    target: { kind: 'session', id: 'session-1' },
    flowId: 'compose-flow',
    attrs: { draftLength: 12, mode: 'chat' },
  });
  await collector.flush();

  expect(client.postUiEvents).toHaveBeenCalledWith({
    schemaVersion: UI_EVENT_SCHEMA_VERSION,
    installId: '00000000-0000-4000-8000-000000000001',
    clientSessionKey: '00000000-0000-4000-8000-000000000002',
    appVersion: expect.any(String),
    events: [expect.objectContaining({
      seq: 1,
      type: 'compose_submit',
      flowId: 'compose-flow',
      attrs: { draftLength: 12, mode: 'chat' },
    })],
  });
  expect(JSON.stringify(client.postUiEvents.mock.calls[0][0])).not.toContain('비밀 초안');
  expect(collector.pendingCount()).toBe(0);
  collector.stop();
});

test('200은 그 요청의 eventId만 제거해 전송 중 추가된 이벤트를 남긴다', async () => {
  const client = {
    getUiEventsConfig: jest.fn().mockResolvedValue(enabledConfig({ maxBatchSize: 1 })),
    postUiEvents: jest.fn(),
  };
  const { collector } = collectorFor(client);
  client.postUiEvents.mockImplementation(async () => {
    collector.record({ type: 'view_open', target: { kind: 'view', id: 'late' } });
    return { accepted: 1, duplicates: 0, rejected: [] };
  });
  await collector.start(scope, 'owner@example.com');
  collector.record({ type: 'view_open', target: { kind: 'view', id: 'first' } });
  collector.record({ type: 'view_open', target: { kind: 'view', id: 'second' } });

  await collector.flush();

  expect(client.postUiEvents).toHaveBeenCalledTimes(1);
  expect(collector.pendingCount()).toBe(2);
  collector.stop();
});

test('422 영구 거절은 해당 배치를 버리고 재시도 대기열에 남기지 않는다', async () => {
  const client = {
    getUiEventsConfig: jest.fn().mockResolvedValue(enabledConfig()),
    postUiEvents: jest.fn().mockRejectedValue(new ApiHttpError('bad envelope', 422, '')),
  };
  const { collector } = collectorFor(client);
  await collector.start(scope, 'owner@example.com');
  collector.record({ type: 'view_open', target: { kind: 'view', id: 'daily' } });

  await collector.flush();

  expect(collector.pendingCount()).toBe(0);
  collector.stop();
});

test('다른 origin 또는 사용자의 영속 대기열은 보내지 않고 버린다', async () => {
  const queueKey = 'soul-app.ui-events.pending.v1';
  const store = storage({
    [queueKey]: JSON.stringify({
      origin: 'https://other.example',
      userEmail: 'other@example.com',
      events: [],
    }),
  });
  const client = {
    getUiEventsConfig: jest.fn().mockResolvedValue(enabledConfig()),
    postUiEvents: jest.fn(),
  };
  const { collector } = collectorFor(client, store);

  await collector.start(scope, 'owner@example.com');

  expect(store.removeItem).toHaveBeenCalledWith(queueKey);
  expect(collector.pendingCount()).toBe(0);
  collector.stop();
});

test('영속 대기열의 과거 실행 봉투는 새 앱 실행 값으로 덮어쓰지 않는다', async () => {
  const queueKey = 'soul-app.ui-events.pending.v1';
  const oldEvent = {
    eventId: 'old-event',
    seq: 17,
    occurredAt: '2026-09-20T00:00:00.000Z',
    type: 'view_open',
    target: { kind: 'session', id: 'old-session' },
    from: null,
    entry: 'feed',
    flowId: null,
    attrs: {},
  };
  const store = storage({
    [queueKey]: JSON.stringify({
      origin: 'https://soul.example',
      userEmail: 'owner@example.com',
      events: [{
        installId: 'old-install',
        clientSessionKey: 'old-app-run',
        appVersion: '0.9.0+1',
        event: oldEvent,
      }],
    }),
  });
  const client = {
    getUiEventsConfig: jest.fn().mockResolvedValue(enabledConfig()),
    postUiEvents: jest.fn().mockResolvedValue({ accepted: 1, duplicates: 0, rejected: [] }),
  };
  const { collector } = collectorFor(client, store);
  await collector.start(scope, 'owner@example.com');

  await collector.flush();

  expect(client.postUiEvents).toHaveBeenCalledWith({
    schemaVersion: UI_EVENT_SCHEMA_VERSION,
    installId: 'old-install',
    clientSessionKey: 'old-app-run',
    appVersion: '0.9.0+1',
    events: [oldEvent],
  });
  collector.stop();
});

test('설정이 꺼져 있으면 수집·대기·전송하지 않는다', async () => {
  const client = {
    getUiEventsConfig: jest.fn().mockResolvedValue(enabledConfig({ enabled: false })),
    postUiEvents: jest.fn(),
  };
  const { collector } = collectorFor(client);
  await collector.start(scope, 'owner@example.com');
  collector.record({ type: 'view_open', target: { kind: 'view', id: 'daily' } });
  await collector.flush();

  expect(collector.pendingCount()).toBe(0);
  expect(client.postUiEvents).not.toHaveBeenCalled();
  collector.stop();
});

test('전송 응답이 disabled면 이후 수집도 즉시 멈춘다', async () => {
  const client = {
    getUiEventsConfig: jest.fn().mockResolvedValue(enabledConfig()),
    postUiEvents: jest.fn().mockResolvedValue({
      accepted: 0,
      duplicates: 0,
      disabled: true,
      rejected: [],
    }),
  };
  const { collector } = collectorFor(client);
  await collector.start(scope, 'owner@example.com');
  collector.record({ type: 'view_open', target: { kind: 'view', id: 'daily' } });

  await collector.flush();
  collector.record({ type: 'view_open', target: { kind: 'view', id: 'feed' } });

  expect(collector.pendingCount()).toBe(0);
  expect(client.postUiEvents).toHaveBeenCalledTimes(1);
  collector.stop();
});
