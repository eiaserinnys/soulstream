import * as FileSystem from 'expo-file-system/legacy';
import { Share } from 'react-native';
import type { AttachmentView } from '../attachment-view';
import { clearAuthForScope, isAuthScopeCurrent, type AuthScopeSnapshot } from '../auth-scope';
import { AttachmentSaveError } from '../attachment-save';
import { saveAttachmentOriginal } from '../attachment-save.native';
import { saveAttachmentOriginal as saveAttachmentOriginalWeb } from '../attachment-save.web';

jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  makeDirectoryAsync: jest.fn(),
  downloadAsync: jest.fn(),
  getInfoAsync: jest.fn(),
  deleteAsync: jest.fn(),
}));

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Share: {
    share: jest.fn(),
    sharedAction: 'sharedAction',
    dismissedAction: 'dismissedAction',
  },
}));

jest.mock('../auth-scope', () => ({
  clearAuthForScope: jest.fn(),
  isAuthScopeCurrent: jest.fn(),
}));

const scope: AuthScopeSnapshot = {
  serverUrl: 'https://attachments.test',
  jwt: 'captured-jwt',
  generation: 'auth-1',
};

const view: AttachmentView = {
  key: 'asset-1',
  name: '원본 보고서.txt',
  mimeType: 'text/plain',
  byteSize: 3,
  previewKind: 'text',
  readContext: { type: 'card', id: 'card-1' },
  source: {
    kind: 'ready',
    attachmentId: 'asset-1',
    previewUrl: '/api/attachments/asset-1/content?context_type=card&context_id=card-1',
    originalUrl: '/api/attachments/asset-1/content?context_type=card&context_id=card-1&download=true',
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(isAuthScopeCurrent).mockReturnValue(true);
  jest.mocked(FileSystem.makeDirectoryAsync).mockResolvedValue(undefined);
  jest.mocked(FileSystem.downloadAsync).mockResolvedValue({
    uri: 'file:///cache/attachment-save/file.txt', status: 200, headers: {}, mimeType: 'text/plain',
  });
  jest.mocked(FileSystem.getInfoAsync).mockResolvedValue({
    exists: true, isDirectory: false, uri: 'file:///cache/attachment-save/file.txt', size: 3,
  });
  jest.mocked(FileSystem.deleteAsync).mockResolvedValue(undefined);
  jest.mocked(Share.share).mockResolvedValue({ action: Share.sharedAction });
});

test('원본 URL과 캡처된 JWT로 내려받고 파일 URI와 iPad anchor를 공유한 뒤 임시 파일을 지운다', async () => {
  await expect(saveAttachmentOriginal({ view, scope, anchor: 42 })).resolves.toBe('shared');

  const [url, destination, options] = jest.mocked(FileSystem.downloadAsync).mock.calls[0];
  expect(url).toBe(`${scope.serverUrl}${view.source.kind === 'ready' ? view.source.originalUrl : ''}`);
  expect(url).not.toContain('preview');
  expect(destination).toMatch(/^file:\/\/\/cache\/attachment-save\/.+\/원본 보고서\.txt$/);
  expect(options).toEqual({ headers: { Authorization: 'Bearer captured-jwt' } });
  expect(jest.mocked(FileSystem.getInfoAsync)).toHaveBeenCalledWith(destination);
  expect(Share.share).toHaveBeenCalledWith({ url: destination }, { anchor: 42 });
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith(destination, { idempotent: true });
});

test('0바이트 원본을 그대로 공유하고 OS 시트 취소는 cancelled로 돌려준다', async () => {
  const emptyView = { ...view, byteSize: 0 };
  jest.mocked(FileSystem.getInfoAsync).mockResolvedValue({
    exists: true, isDirectory: false, uri: 'file:///cache/empty.txt', size: 0,
  });
  jest.mocked(Share.share).mockResolvedValue({ action: Share.dismissedAction });

  await expect(saveAttachmentOriginal({ view: emptyView, scope })).resolves.toBe('cancelled');
  expect(Share.share).toHaveBeenCalledTimes(1);
  expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(1);
});

test.each([401, 403, 503])('HTTP %i 다운로드 실패는 OS 공유를 열지 않는다', async (status) => {
  jest.mocked(FileSystem.downloadAsync).mockResolvedValue({
    uri: 'file:///cache/error.txt', status, headers: {}, mimeType: 'text/plain',
  });

  await expect(saveAttachmentOriginal({ view, scope })).rejects.toMatchObject({
    name: 'AttachmentSaveError', code: 'DOWNLOAD_FAILED',
  });
  expect(Share.share).not.toHaveBeenCalled();
  expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(1);
  expect(clearAuthForScope).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
});

test('다운로드 도중 auth scope가 바뀌면 공유하지 않고 임시 파일을 지운다', async () => {
  jest.mocked(isAuthScopeCurrent).mockReturnValueOnce(true).mockReturnValueOnce(false);

  await expect(saveAttachmentOriginal({ view, scope })).resolves.toBe('cancelled');
  expect(Share.share).not.toHaveBeenCalled();
  expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(1);
});

test('native 다운로드 도중 취소되면 결과를 공유하지 않고 임시 파일을 지운다', async () => {
  const controller = new AbortController();
  jest.mocked(FileSystem.downloadAsync).mockImplementation(async (url, destination, options) => {
    controller.abort();
    return { uri: destination, status: 200, headers: {}, mimeType: 'text/plain' };
  });

  await expect(saveAttachmentOriginal({ view, scope, signal: controller.signal })).resolves.toBe('cancelled');
  expect(Share.share).not.toHaveBeenCalled();
  expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(1);
});

test('외부 origin과 unavailable 첨부는 다운로드하거나 공유하지 않는다', async () => {
  const external = { ...view, source: { ...view.source, originalUrl: 'https://other.test/private.txt' } } as AttachmentView;
  const unavailable = { ...view, source: { kind: 'unavailable', availability: 'missing' } } as AttachmentView;

  await expect(saveAttachmentOriginal({ view: external, scope })).rejects.toBeInstanceOf(AttachmentSaveError);
  await expect(saveAttachmentOriginal({ view: unavailable, scope })).rejects.toBeInstanceOf(AttachmentSaveError);
  expect(FileSystem.downloadAsync).not.toHaveBeenCalled();
  expect(Share.share).not.toHaveBeenCalled();
});

test('웹은 원본을 blob으로 받아 로컬 다운로드 링크로 저장한다', async () => {
  const oldFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const oldCreateObjectUrl = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
  const oldRevokeObjectUrl = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
  const click = jest.fn();
  const anchor = { href: '', download: '', click };
  const createElement = jest.fn(() => anchor);
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    blob: async () => new Blob(['abc'], { type: 'text/plain' }),
  });
  const createObjectURL = jest.fn(() => 'blob:attachment');
  const revokeObjectURL = jest.fn();
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement } });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });

  try {
    await expect(saveAttachmentOriginalWeb({ view, scope })).resolves.toBe('shared');
    expect(fetchMock).toHaveBeenCalledWith(
      `${scope.serverUrl}${view.source.kind === 'ready' ? view.source.originalUrl : ''}`,
      { headers: { Authorization: 'Bearer captured-jwt' } },
    );
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(anchor).toMatchObject({ href: 'blob:attachment', download: '원본 보고서.txt' });
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:attachment');
  } finally {
    for (const [target, key, descriptor] of [
      [globalThis, 'fetch', oldFetch],
      [globalThis, 'document', oldDocument],
      [URL, 'createObjectURL', oldCreateObjectUrl],
      [URL, 'revokeObjectURL', oldRevokeObjectUrl],
    ] as const) {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else Reflect.deleteProperty(target, key);
    }
  }
});
