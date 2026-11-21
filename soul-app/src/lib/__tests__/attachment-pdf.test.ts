import { Platform } from 'react-native';
import {
  AttachmentReadFailure,
  attachmentPdfViewerUri,
  pdfCacheName,
  pdfFailureKindForStatus,
} from '../attachment-pdf';

type MockFileSystemState = {
  directoryExists: boolean;
  createCalls: unknown[];
  fileExists: boolean;
  downloads: Array<{ url: string; destination: { uri: string }; options: Record<string, unknown> }>;
  downloadError: unknown;
};

// The state lives inside the mock factory: jest.mock is hoisted above imports,
// so a module-scope object would still be uninitialized when the module loads.
jest.mock('expo-file-system', () => {
  const state: MockFileSystemState = {
    directoryExists: false,
    createCalls: [],
    fileExists: false,
    downloads: [],
    downloadError: null,
  };
  class Directory {
    readonly uri: string;

    constructor(...args: Array<string | { uri: string }>) {
      this.uri = args.map((arg) => (typeof arg === 'string' ? arg : arg.uri)).join('/');
    }

    get exists() {
      return state.directoryExists;
    }

    create(options: unknown) {
      state.createCalls.push(options);
    }
  }
  class File {
    readonly uri: string;

    constructor(...args: Array<string | Directory>) {
      const name = typeof args[args.length - 1] === 'string' ? args[args.length - 1] as string : '';
      this.uri = `file:///cache/attachment-pdf/${name}`;
    }

    get exists() {
      return state.fileExists;
    }

    text() {
      return Promise.resolve('');
    }

    static readonly downloadFileAsync = async (
      url: string,
      destination: { uri: string },
      options: Record<string, unknown>,
    ) => {
      state.downloads.push({ url, destination, options });
      if (state.downloadError) throw state.downloadError;
      return { uri: `${destination.uri}` };
    };
  }
  return { Directory, File, Paths: { cache: new Directory('file:///cache') }, state };
});

const mockFs = jest.requireMock('expo-file-system') as { state: MockFileSystemState };

function signal(): AbortSignal {
  return new AbortController().signal;
}

beforeEach(() => {
  mockFs.state.directoryExists = false;
  mockFs.state.createCalls = [];
  mockFs.state.fileExists = false;
  mockFs.state.downloads = [];
  mockFs.state.downloadError = null;
});

test('HTTP 상태를 미리보기 창의 실패 종류로 옮긴다', () => {
  expect(pdfFailureKindForStatus(401)).toBe('unauthorized');
  expect(pdfFailureKindForStatus(403)).toBe('denied');
  expect(pdfFailureKindForStatus(404)).toBe('not-found');
  expect(pdfFailureKindForStatus(409)).toBe('conflict');
  expect(pdfFailureKindForStatus(408)).toBe('retryable');
  expect(pdfFailureKindForStatus(429)).toBe('retryable');
  expect(pdfFailureKindForStatus(503)).toBe('retryable');
  expect(pdfFailureKindForStatus(undefined)).toBe('retryable');
  expect(pdfFailureKindForStatus(400)).toBe('preview-failed');
});

test('캐시 이름은 경로 문자를 지우고 같은 키에 같은 이름을 준다', () => {
  const first = pdfCacheName('node-1:docs/보고서.pdf');
  expect(first).toBe(pdfCacheName('node-1:docs/보고서.pdf'));
  expect(first).not.toMatch(/[/:]/);
  expect(first).toMatch(/^[a-zA-Z0-9._-]+-[0-9a-f]+$/);
  expect(pdfCacheName('a'.repeat(200)).length).toBeLessThanOrEqual(80);
  expect(new Set([pdfCacheName('a'), pdfCacheName('b')]).size).toBe(2);
});

test('file URI는 그대로 넘긴다', async () => {
  await expect(attachmentPdfViewerUri({
    uri: 'file:///tmp/doc.pdf', cacheKey: 'doc', signal: signal(),
  })).resolves.toBe('file:///tmp/doc.pdf');
  expect(mockFs.state.downloads).toHaveLength(0);
});

test('iOS는 인증 헤더로 캐시에 내려받은 file URI를 그대로 쓴다', async () => {
  const cacheKey = 'asset/1';
  const controller = new AbortController();
  await expect(attachmentPdfViewerUri({
    uri: 'https://soul.test/api/attachments/asset%2F1/content',
    headers: { Authorization: 'Bearer jwt' },
    cacheKey,
    signal: controller.signal,
  })).resolves.toBe(`file:///cache/attachment-pdf/${pdfCacheName(cacheKey)}.pdf`);

  expect(mockFs.state.createCalls).toEqual([{ idempotent: true, intermediates: true }]);
  expect(mockFs.state.downloads).toHaveLength(1);
  const [download] = mockFs.state.downloads;
  expect(download).toMatchObject({
    url: 'https://soul.test/api/attachments/asset%2F1/content',
    options: {
      headers: { Authorization: 'Bearer jwt' },
      idempotent: true,
      signal: controller.signal,
    },
  });
});

test('이미 받아 둔 PDF는 다시 내려받지 않는다', async () => {
  mockFs.state.fileExists = true;
  await attachmentPdfViewerUri({
    uri: 'https://soul.test/api/attachments/a/content', cacheKey: 'a', signal: signal(),
  });
  expect(mockFs.state.downloads).toHaveLength(0);
});

test('내려받기 실패는 상태 코드에 맞는 실패로 바뀐다', async () => {
  mockFs.state.downloadError = new Error('download failed (status 404)');
  await expect(attachmentPdfViewerUri({
    uri: 'https://soul.test/api/attachments/a/content', cacheKey: 'a', signal: signal(),
  })).rejects.toMatchObject({ kind: 'not-found' });
  await expect(attachmentPdfViewerUri({
    uri: 'https://soul.test/api/attachments/a/content', cacheKey: 'a', signal: signal(),
  })).rejects.toBeInstanceOf(AttachmentReadFailure);
});

test('웹은 응답을 blob URL로 바꾸고 실패 상태를 옮긴다', async () => {
  const platform = jest.replaceProperty(Platform, 'OS', 'web');
  const createObjectURL = jest.fn(() => 'blob:pdf-1');
  Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
  const fetchMock = jest.spyOn(global, 'fetch');
  try {
    fetchMock.mockResolvedValueOnce(new Response(new Blob(['%PDF']), { status: 200 }));
    await expect(attachmentPdfViewerUri({
      uri: 'https://soul.test/api/attachments/a/content',
      headers: { Authorization: 'Bearer jwt' },
      cacheKey: 'a',
      signal: signal(),
    })).resolves.toBe('blob:pdf-1');
    expect(fetchMock).toHaveBeenCalledWith('https://soul.test/api/attachments/a/content', {
      headers: { Authorization: 'Bearer jwt' },
      signal: expect.any(AbortSignal),
    });

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(attachmentPdfViewerUri({
      uri: 'https://soul.test/api/attachments/a/content', cacheKey: 'a', signal: signal(),
    })).rejects.toMatchObject({ kind: 'not-found' });
  } finally {
    fetchMock.mockRestore();
    platform.restore();
  }
});
