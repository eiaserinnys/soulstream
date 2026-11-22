import { createApiClient } from '../client';
import { MAX_ATTACHMENT_TEXT_BYTES } from '../../lib/attachment-view';

afterEach(() => jest.restoreAllMocks());

test('세션 파일 원문은 인증과 Range를 붙여 경로 그대로 읽는다', async () => {
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('hello', {
    status: 206, headers: { 'Content-Range': 'bytes 0-4/5' },
  }));
  const api = createApiClient('https://example.test', { authToken: 'token' });
  await expect(api.readSessionWorkspaceText('s/1', 'dir/한글.txt')).resolves.toEqual({ text: 'hello', truncated: false });
  expect(fetchMock.mock.calls[0][0]).toBe('https://example.test/api/sessions/s%2F1/workspace/file?path=dir%2F%ED%95%9C%EA%B8%80.txt');
  const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
  expect(headers.get('Authorization')).toBe('Bearer token');
  expect(headers.get('Range')).toBe(`bytes=0-${MAX_ATTACHMENT_TEXT_BYTES - 1}`);
});

test('크기를 모르는 빈 파일의 Range 416은 빈 원문으로 표시한다', async () => {
  jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */0' } }));
  const api = createApiClient('https://example.test', { authToken: 'token' });
  await expect(api.readSessionWorkspaceText('s', 'empty.txt')).resolves.toEqual({ text: '', truncated: false });
});
