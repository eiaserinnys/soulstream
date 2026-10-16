import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { SessionEvent } from '../../api/types';
import type { SessionEventAttachmentResponse } from '../../../../packages/wire-schema/src/attachments';
import { resetAuthScopeForTest } from '../../lib/auth-scope';
import { useAuthStore } from '../../store/authStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useMessageAttachments } from '../useMessageAttachments';

const readContext = { type: 'session', id: 'route/session' } as const;

function event(id: string, type: SessionEvent['type'] = 'user_message', data: Record<string, unknown> = {}): SessionEvent {
  return { id, type, data };
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Not Found',
    headers: { get: (name: string) => name.toLowerCase() === 'content-type' ? 'application/json' : null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const assetProjection = {
  kind: 'asset' as const,
  descriptor: {
    attachment_id: 'asset-1', name: 'photo.png', mime_type: 'image/png', byte_size: 128,
    checksum_sha256: null, width: 10, height: 10, preview_kind: 'image' as const, preview_mime_type: 'image/png',
  },
  read_context: readContext,
  legacy_sources: [{ node_id: 'node-1', path: '/incoming/photo.png' }],
};

beforeEach(() => {
  useSettingsStore.setState({ serverUrl: 'https://chat.test' });
  useAuthStore.setState({ jwt: 'test-jwt' });
  resetAuthScopeForTest();
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('live와 history projection은 서버 순서와 alias 병합을 그대로 공유한다', async () => {
  const missingLegacy = {
    kind: 'legacy' as const, node_id: 'node-1', path: '/incoming/missing.txt', name: 'missing.txt',
    mime_type: 'text/plain', byte_size: null, availability: 'missing' as const, read_context: readContext,
  };
  const body = { event_id: 41, items: [assetProjection, missingLegacy] } satisfies SessionEventAttachmentResponse;
  const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(response(body));
  const { result, rerender, unmount } = renderHook(
    ({ current }: { current: SessionEvent }) => useMessageAttachments({ event: current, readContext }),
    { initialProps: { current: event('41', 'user_message', { attachment_ids: ['asset-1'], attachments: ['/incoming/photo.png'] }) } },
  );

  await waitFor(() => expect(result.current.items).toHaveLength(2));
  const liveItems = result.current.items;
  expect(liveItems.map(item => item.key)).toEqual(['asset-1', '/incoming/missing.txt']);
  expect(liveItems[0]).toMatchObject({
    name: 'photo.png', previewKind: 'image', readContext,
    source: { kind: 'ready', attachmentId: 'asset-1', previewUrl: '/api/attachments/asset-1/content?context_type=session&context_id=route%2Fsession' },
  });
  expect(liveItems[1]).toMatchObject({ source: { kind: 'unavailable', availability: 'missing' } });

  rerender({ current: event('41', 'user_message', { attachment_ids: ['asset-1'], attachments: ['/incoming/photo.png'] }) });
  await waitFor(() => expect(result.current.items).toEqual(liveItems));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenNthCalledWith(1,
    'https://chat.test/api/sessions/route%2Fsession/events/41/attachments', expect.objectContaining({ method: 'GET' }));
  unmount();
});

test('첨부 신호가 없거나 지원하지 않는 이벤트면 읽기 요청을 보내지 않는다', () => {
  const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(response({ event_id: 1, items: [] }));
  const { result, rerender, unmount } = renderHook(
    ({ current }: { current: SessionEvent }) => useMessageAttachments({ event: current, readContext }),
    { initialProps: { current: event('1', 'user_message', { content: '본문만' }) } },
  );
  rerender({ current: event('2', 'system', { attachment_ids: ['asset-1'] }) });
  expect(fetch).not.toHaveBeenCalled();
  expect(result.current.items).toEqual([]);
  unmount();
});

test('인증 범위가 바뀐 뒤 늦게 온 projection은 화면에 남지 않는다', async () => {
  let resolveFirst!: (value: Response) => void;
  const fetch = jest.spyOn(global, 'fetch')
    .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
    .mockImplementation(() => new Promise(() => {}));
  const { result, unmount } = renderHook(() => useMessageAttachments({
    event: event('41', 'intervention_sent', { attachments: ['/incoming/photo.png'] }), readContext,
  }));

  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  await act(async () => { useAuthStore.setState({ jwt: 'new-jwt' }); });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  await act(async () => {
    resolveFirst(response({ event_id: 41, items: [assetProjection] }));
    await Promise.resolve();
  });
  expect(result.current.items).toEqual([]);
  unmount();
});

test('retry refetches an event projection after a failed request', async () => {
  const fetch = jest.spyOn(global, 'fetch')
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(response({ event_id: 41, items: [assetProjection] }));
  const { result, unmount } = renderHook(() => useMessageAttachments({
    event: event('41', 'user_message', { attachment_ids: ['asset-1'] }), readContext,
  }));

  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(result.current.items).toHaveLength(1));
  expect(result.current.items[0]).toMatchObject({
    key: 'asset-1',
    source: { kind: 'unavailable', availability: 'unavailable' },
  });
  await act(async () => { result.current.retry(); });
  await waitFor(() => expect(result.current.items[0]).toMatchObject({
    key: 'asset-1',
    source: { kind: 'ready', attachmentId: 'asset-1' },
  }));
  expect(fetch).toHaveBeenCalledTimes(2);
  unmount();
});

test('ID-only projection resolves metadata from the session context without a node id', async () => {
  const descriptor = {
    attachment_id: 'asset-offline', name: 'offline.png', mime_type: 'image/png', byte_size: 24,
    checksum_sha256: null, width: 4, height: 3, preview_kind: 'image', preview_mime_type: 'image/png',
  };
  const fetch = jest.spyOn(global, 'fetch')
    .mockResolvedValueOnce(response({ event_id: 52, items: [{ kind: 'unavailable', attachment_id: 'asset-offline',
      name: null, availability: 'unavailable', read_context: readContext }] }))
    .mockResolvedValueOnce(response({ descriptor, upload_status: 'ready' }));
  const { result, unmount } = renderHook(() => useMessageAttachments({
    event: event('52', 'user_message', { attachment_ids: ['asset-offline'] }), readContext,
  }));

  await waitFor(() => expect(result.current.items[0]?.source).toMatchObject({ kind: 'ready', attachmentId: 'asset-offline' }));
  expect(fetch).toHaveBeenNthCalledWith(2,
    'https://chat.test/api/attachments/asset-offline?context_type=session&context_id=route%2Fsession',
    expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(result.current.items).toHaveLength(1);
  unmount();
});

test('ID and unresolved legacy projection remain ordered when the legacy node is offline', async () => {
  const descriptor = {
    attachment_id: 'asset-1', name: 'photo.png', mime_type: 'image/png', byte_size: 24,
    checksum_sha256: null, width: 4, height: 3, preview_kind: 'image', preview_mime_type: 'image/png',
  };
  const fetch = jest.spyOn(global, 'fetch')
    .mockResolvedValueOnce(response({ event_id: 53, items: [
      { kind: 'unavailable', attachment_id: 'asset-1', name: null,
        availability: 'unavailable', read_context: readContext },
      { kind: 'legacy', node_id: 'offline-node', path: '/incoming/old.txt', name: 'old.txt',
        mime_type: 'text/plain', byte_size: null, availability: 'unresolved', read_context: readContext },
    ] }))
    .mockResolvedValueOnce(response({ descriptor, upload_status: 'ready' }))
    .mockResolvedValueOnce(response({}, 503));
  const { result, unmount } = renderHook(() => useMessageAttachments({
    event: event('53', 'intervention_sent', {
      attachment_ids: ['asset-1'], attachments: ['/incoming/old.txt'],
    }), readContext,
  }));

  await waitFor(() => expect(result.current.items).toHaveLength(2));
  expect(result.current.items.map(item => item.key)).toEqual(['asset-1', '/incoming/old.txt']);
  expect(result.current.items[0].source).toMatchObject({ kind: 'ready', attachmentId: 'asset-1' });
  expect(result.current.items[1]).toMatchObject({
    name: 'old.txt', source: { kind: 'unavailable', availability: 'unavailable' },
  });
  unmount();
});
