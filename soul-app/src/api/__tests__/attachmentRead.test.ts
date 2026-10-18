import { createApiClient } from '../client';
import { MAX_ATTACHMENT_TEXT_BYTES } from '../../lib/attachment-view';

const BASE = 'https://attachments.test';
const descriptor = {
  attachment_id: 'asset/1', name: 'notes.txt', mime_type: 'text/plain', byte_size: 3,
  checksum_sha256: null, width: null, height: null, preview_kind: 'text', preview_mime_type: 'text/plain',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(body: BodyInit | null, status = 200, headers: HeadersInit = {}): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain', ...headers } });
}

afterEach(() => jest.restoreAllMocks());

test('metadata read uses the supplied session/card context and auth scope', async () => {
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(jsonResponse({
    descriptor, upload_status: 'committed',
  }));
  const signal = new AbortController().signal;
  const api = createApiClient(BASE, { authToken: 'test-jwt' });

  await expect(api.getAttachmentMetadata('asset/1', { type: 'card', id: 'card/1' }, signal))
    .resolves.toEqual({ descriptor, upload_status: 'committed' });

  expect(fetchMock.mock.calls[0][0]).toBe(
    `${BASE}/api/attachments/asset%2F1?context_type=card&context_id=card%2F1`,
  );
  expect(fetchMock.mock.calls[0][1]).toMatchObject({ signal });
  expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer test-jwt');
});

test('text read requests a bounded byte range and omits an incomplete UTF-8 character', async () => {
  const prefix = new TextEncoder().encode('a'.repeat(MAX_ATTACHMENT_TEXT_BYTES - 1));
  const tail = new TextEncoder().encode('가');
  const allBytes = new Uint8Array(prefix.length + tail.length);
  allBytes.set(prefix);
  allBytes.set(tail, prefix.length);
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(textResponse(
    allBytes.subarray(0, MAX_ATTACHMENT_TEXT_BYTES),
    206,
    { 'Content-Range': `bytes 0-${MAX_ATTACHMENT_TEXT_BYTES - 1}/${allBytes.length}` },
  ));
  const api = createApiClient(BASE, { authToken: 'test-jwt' });

  const preview = await api.readAttachmentText('asset/1', { type: 'session', id: 'session-1' });

  expect(preview).toEqual({ text: 'a'.repeat(MAX_ATTACHMENT_TEXT_BYTES - 1), truncated: true });
  expect(fetchMock.mock.calls[0][0]).toBe(
    `${BASE}/api/attachments/asset%2F1/content?context_type=session&context_id=session-1`,
  );
  expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Range'))
    .toBe(`bytes=0-${MAX_ATTACHMENT_TEXT_BYTES - 1}`);
  expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer test-jwt');
});

test('range 무시로 더 큰 body를 받은 경우 제한된 앞부분만 읽고 stream을 취소한다', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('x'.repeat(MAX_ATTACHMENT_TEXT_BYTES + 10)));
    },
    cancel() { cancelled = true; },
  });
  jest.spyOn(global, 'fetch').mockResolvedValue(new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  }));
  const api = createApiClient(BASE, { authToken: 'test-jwt' });

  const preview = await api.readAttachmentText('asset/1', { type: 'owner' });

  expect(preview).toEqual({ text: 'x'.repeat(MAX_ATTACHMENT_TEXT_BYTES), truncated: true });
  expect(cancelled).toBe(true);
});

test.each([
  [401, 'unauthorized'],
  [403, 'denied'],
  [404, 'not-found'],
  [409, 'conflict'],
  [502, 'retryable'],
  [503, 'retryable'],
  [504, 'retryable'],
] as const)('HTTP %i를 %s 읽기 오류로 구분한다', async (status, kind) => {
  jest.spyOn(global, 'fetch').mockResolvedValue(textResponse('', status));
  const api = createApiClient(BASE, { authToken: 'test-jwt' });

  await expect(api.readAttachmentText('asset/1', { type: 'card', id: 'card-1' }))
    .rejects.toMatchObject({ kind, status });
});

test('metadata 404는 attachment missing 상태가 아닌 HTTP 오류로 보존한다', async () => {
  jest.spyOn(global, 'fetch').mockResolvedValue(jsonResponse({ detail: 'not found' }, 404));
  const api = createApiClient(BASE, { authToken: 'test-jwt' });

  await expect(api.getAttachmentMetadata('asset/1', { type: 'card', id: 'card-1' }))
    .rejects.toMatchObject({ name: 'ApiHttpError', status: 404 });
});

test('legacy 문서 본문은 원문 files URL로 인증 GET과 바이트 범위를 보낸다', async () => {
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(textResponse('<h1>문서 본문</h1>'));
  const api = createApiClient(BASE, { authToken: 'test-jwt' });
  const href = `${BASE}/api/attachments/files?nodeId=node-1&path=%2Fincoming%2Fproposal.html&context_type=card&context_id=card-1`;

  await expect(api.readLegacyAttachmentText(href)).resolves.toEqual({ text: '<h1>문서 본문</h1>', truncated: false });

  expect(fetchMock.mock.calls[0][0]).toBe(href);
  expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Range'))
    .toBe(`bytes=0-${MAX_ATTACHMENT_TEXT_BYTES - 1}`);
  expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer test-jwt');
});

test('legacy 본문 읽기는 id URL이나 다른 출처의 링크를 요청하지 않는다', async () => {
  const fetchMock = jest.spyOn(global, 'fetch');
  const api = createApiClient(BASE, { authToken: 'test-jwt' });

  await expect(api.readLegacyAttachmentText(`${BASE}/api/attachments/asset-1/content?context_type=card&context_id=card-1`))
    .rejects.toMatchObject({ name: 'AttachmentReadError', kind: 'preview-failed' });
  await expect(api.readLegacyAttachmentText('https://outside.test/api/attachments/files?nodeId=n&path=%2Fa.txt'))
    .rejects.toMatchObject({ name: 'AttachmentReadError', kind: 'preview-failed' });
  expect(fetchMock).not.toHaveBeenCalled();
});

test('body stream이 없는 RN Response도 text()의 실제 본문을 읽는다', async () => {
  const headers = new Headers({ 'Content-Type': 'text/html; charset=utf-8' });
  const withoutBody = { ok: true, status: 200, headers, body: null, text: async () => '<h1>문서 본문</h1>' };
  jest.spyOn(global, 'fetch').mockResolvedValue(withoutBody as unknown as Response);
  const api = createApiClient(BASE, { authToken: 'test-jwt' });

  await expect(api.readAttachmentText('asset/1', { type: 'owner' }))
    .resolves.toEqual({ text: '<h1>문서 본문</h1>', truncated: false });
});
