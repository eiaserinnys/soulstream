import { uploadNativeMultipart } from '../nativeMultipartUpload';
import type { NativeUploadFile } from '../nativeUpload';

type MockFileFixture = {
  exists: boolean;
  size: number;
  readLengths: number[];
  openedWith?: string;
  closeCount: number;
  shortRead?: boolean;
};

var mockFileFixtures: Record<string, MockFileFixture> = {};

jest.mock('expo-file-system', () => ({
  FileMode: { ReadOnly: 'r' },
  File: class MockFile {
    readonly uri: string;

    constructor(uri: string) {
      this.uri = uri;
    }

    get exists(): boolean {
      return mockFileFixtures[this.uri]?.exists ?? false;
    }

    get size(): number {
      return mockFileFixtures[this.uri]?.size ?? 0;
    }

    open(mode: string) {
      const fixture = mockFileFixtures[this.uri];
      if (!fixture) throw new Error('missing fixture');
      fixture.openedWith = mode;
      let offset = 0;
      return {
        readBytes(length: number) {
          fixture.readLengths.push(length);
          if (fixture.shortRead) return new Uint8Array(0);
          const count = Math.min(length, fixture.size - offset);
          offset += count;
          return new Uint8Array(count);
        },
        close() {
          fixture.closeCount += 1;
        },
      };
    }
  },
}));

const MiB = 1024 * 1024;
const PART_SIZE = 16 * MiB;
const MAX_SIZE = 5 * 1024 ** 3;
const LARGE_URI = 'file:///cache/large.bin';

function jsonResponse(body: unknown, status = 201, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 201 ? 'Created' : status === 200 ? 'OK' : 'Error',
    headers: new Headers({ 'Content-Type': 'application/json', ...headers }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function installFile(uri: string, size: number, overrides: Partial<MockFileFixture> = {}): MockFileFixture {
  const fixture: MockFileFixture = {
    exists: true,
    size,
    readLengths: [],
    closeCount: 0,
    ...overrides,
  };
  mockFileFixtures[uri] = fixture;
  return fixture;
}

function createHarness(
  size: number,
  options: {
    partSize?: number;
    completeStatus?: number;
    completeBody?: unknown;
    shortRead?: boolean;
    reverseParts?: boolean;
    partCountDelta?: number;
    putFetch?: typeof fetch;
  } = {},
) {
  const fixture = installFile(LARGE_URI, size, { shortRead: options.shortRead });
  const partCount = Math.ceil(size / (options.partSize ?? PART_SIZE)) + (options.partCountDelta ?? 0);
  const parts = Array.from({ length: partCount }, (_, index) => ({
    partNumber: index + 1,
    url: `https://r2.example/part/${index + 1}`,
  }));
  if (options.reverseParts) parts.reverse();
  const authFetch = jest.fn(async (input: string, init?: RequestInit) => {
    if (input.includes('/multipart/init?')) {
      return jsonResponse({ ticket: 'upload-ticket', partSize: options.partSize ?? PART_SIZE, parts });
    }
    if (input.includes('/multipart/complete?')) {
      return jsonResponse(options.completeBody ?? {
        path: '/session/file.bin', filename: 'file.bin', size, content_type: 'application/octet-stream',
      }, options.completeStatus ?? 201);
    }
    if (input.includes('/multipart/abort?')) return jsonResponse({ aborted: true }, 200);
    throw new Error(`unexpected authenticated request ${input} ${init?.method ?? ''}`);
  });
  const readJson = jest.fn(async (response: Response, operation: string) => {
    if (!response.ok) throw new Error(`[${operation}] HTTP ${response.status} — ${await response.text()}`);
    return response.json();
  });
  const putFetch = options.putFetch ?? jest.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    jsonResponse(null, 200, { etag: '"etag-1"' }));
  global.fetch = putFetch;

  async function run(signal?: AbortSignal) {
    return uploadNativeMultipart({
      base: 'https://api.example',
      authFetch,
      readJson,
      sessionId: 'session-1',
      nodeId: 'node/1',
      folderId: 'folder-1',
      file: { uri: LARGE_URI, name: 'file.bin', type: 'application/octet-stream' } satisfies NativeUploadFile,
      signal,
    });
  }

  return { authFetch, readJson, putFetch, fixture, run };
}

beforeEach(() => {
  mockFileFixtures = {};
  jest.restoreAllMocks();
});

describe('uploadNativeMultipart', () => {
  it('reads the actual file metadata and rejects a missing file before creating a ticket', async () => {
    const harness = createHarness(64 * MiB);
    harness.fixture.exists = false;

    await expect(harness.run()).rejects.toThrow(/파일/);

    expect(harness.authFetch).not.toHaveBeenCalled();
  });

  it('streams bounded parts, allows at most two PUTs, sorts ETags, and closes a read-only handle', async () => {
    const size = 64 * MiB + 3;
    let activePuts = 0;
    let maxActivePuts = 0;
    const putFetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      activePuts += 1;
      maxActivePuts = Math.max(maxActivePuts, activePuts);
      await Promise.resolve();
      activePuts -= 1;
      const partNumber = Number(String(input).split('/').pop());
      return jsonResponse(null, 200, { etag: `"etag-${partNumber}"` });
    });
    const harness = createHarness(size, { putFetch, reverseParts: true });
    const expectedParts = Array.from({ length: 5 }, (_, index) => ({
      partNumber: index + 1,
      url: `https://r2.example/part/${index + 1}`,
    }));
    const result = await harness.run();

    expect(result).toEqual({
      path: '/session/file.bin', filename: 'file.bin', size, content_type: 'application/octet-stream',
    });
    expect(maxActivePuts).toBe(2);
    expect(harness.fixture.readLengths).toEqual([PART_SIZE, PART_SIZE, PART_SIZE, PART_SIZE, 3]);
    expect(harness.fixture.openedWith).toBe('r');
    expect(harness.fixture.closeCount).toBe(1);
    expect(putFetch.mock.calls.every(([, init]) => !new Headers(init?.headers).has('authorization'))).toBe(true);
    expect(putFetch.mock.calls.map(([input]) => String(input))).toEqual(expectedParts.map((part) => part.url));
    const initCall = harness.authFetch.mock.calls.find(([input]) => input.includes('/multipart/init?'));
    expect(initCall?.[0]).toBe('https://api.example/api/attachments/sessions/multipart/init?nodeId=node%2F1');
    expect(JSON.parse(String(initCall?.[1]?.body))).toEqual({
      session_id: 'session-1',
      folder_id: 'folder-1',
      filename: 'file.bin',
      size,
      content_type: 'application/octet-stream',
    });
    const completeCall = harness.authFetch.mock.calls.find(([input]) => input.includes('/multipart/complete?'));
    expect(completeCall).toBeDefined();
    const completeBody = JSON.parse(String(completeCall?.[1]?.body));
    expect(completeBody.parts).toEqual(expectedParts.map((part) => ({
      partNumber: part.partNumber,
      etag: `"etag-${part.partNumber}"`,
    })));
    expect(harness.authFetch.mock.calls.some(([input]) => input.includes('/multipart/abort?'))).toBe(false);
  });

  it.each([
    ['part 크기', { partSize: 8 * MiB }, /part 설정/],
    ['part 개수', { partCountDelta: -1 }, /part 개수/],
  ])('rejects an invalid server %s and aborts the initialized ticket', async (_name, options, error) => {
    const harness = createHarness(64 * MiB, options);

    await expect(harness.run()).rejects.toThrow(error);

    expect(harness.fixture.readLengths).toEqual([]);
    expect(harness.authFetch.mock.calls.filter(([input]) => input.includes('/multipart/abort?'))).toHaveLength(1);
  });

  it('aborts in-flight PUTs and the server ticket once after a part failure', async () => {
    let secondSignal: AbortSignal | undefined;
    const putFetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/part/1')) return Promise.resolve(jsonResponse({}, 500));
      secondSignal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        secondSignal?.addEventListener('abort', () => reject(new Error('put aborted')), { once: true });
      });
    });
    const harness = createHarness(64 * MiB, { putFetch });

    await expect(harness.run()).rejects.toThrow(/HTTP 500/);

    expect(secondSignal?.aborted).toBe(true);
    expect(harness.authFetch.mock.calls.filter(([input]) => input.includes('/multipart/abort?'))).toHaveLength(1);
    expect(harness.authFetch.mock.calls.some(([input]) => input.includes('/multipart/complete?'))).toBe(false);
  });

  it('cancels in-flight PUTs when the caller aborts and aborts the server ticket once', async () => {
    let resolveStarted!: () => void;
    let putSignal: AbortSignal | undefined;
    const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
    const putFetch = jest.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal as AbortSignal;
      putSignal = signal;
      resolveStarted();
      signal.addEventListener('abort', () => reject(new Error('put aborted')), { once: true });
    }));
    const harness = createHarness(64 * MiB, { putFetch });
    const controller = new AbortController();
    const upload = harness.run(controller.signal);

    await started;
    controller.abort();
    await expect(upload).rejects.toThrow(/put aborted/);

    expect(putSignal?.aborted).toBe(true);
    expect(harness.authFetch.mock.calls.filter(([input]) => input.includes('/multipart/abort?'))).toHaveLength(1);
    expect(harness.authFetch.mock.calls.some(([input]) => input.includes('/multipart/complete?'))).toBe(false);
  });

  it('rejects a successful part response without an ETag and aborts the ticket once', async () => {
    const harness = createHarness(64 * MiB, {
      putFetch: jest.fn(async () => jsonResponse(null, 200)),
    });

    await expect(harness.run()).rejects.toThrow(/ETag/);

    expect(harness.authFetch.mock.calls.filter(([input]) => input.includes('/multipart/abort?'))).toHaveLength(1);
    expect(harness.authFetch.mock.calls.some(([input]) => input.includes('/multipart/complete?'))).toBe(false);
  });

  it('preserves a server 409 restart message and aborts the uncommitted ticket once', async () => {
    const harness = createHarness(64 * MiB, {
      completeStatus: 409,
      completeBody: { detail: '업로드를 다시 시작해 주세요' },
    });

    await expect(harness.run()).rejects.toThrow(/업로드를 다시 시작해 주세요/);

    expect(harness.authFetch.mock.calls.filter(([input]) => input.includes('/multipart/abort?'))).toHaveLength(1);
  });

  it('rejects files above 5 GiB before network or file reads', async () => {
    const harness = createHarness(MAX_SIZE + 1);

    await expect(harness.run()).rejects.toThrow(/5GiB/);

    expect(harness.authFetch).not.toHaveBeenCalled();
    expect(harness.fixture.readLengths).toEqual([]);
  });

  it('accepts the exact 5 GiB metadata boundary without allocating the file contents', async () => {
    const harness = createHarness(MAX_SIZE, { shortRead: true });

    await expect(harness.run()).rejects.toThrow(/파일 크기/);

    const initCall = harness.authFetch.mock.calls.find(([input]) => input.includes('/multipart/init?'));
    expect(initCall).toBeDefined();
    expect(JSON.parse(String(initCall?.[1]?.body)).size).toBe(MAX_SIZE);
    expect(harness.fixture.readLengths).toEqual([PART_SIZE]);
    expect(harness.authFetch.mock.calls.filter(([input]) => input.includes('/multipart/abort?'))).toHaveLength(1);
  });
});
