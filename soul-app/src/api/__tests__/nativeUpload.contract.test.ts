/**
 * 업로드 multipart 본문의 기기 조건 계약 테스트.
 *
 * Expo SDK 57부터 앱 전역 fetch는 Expo winter fetch이고, 전송 직전
 * `convertFormDataAsync`가 FormData 조각을 직렬화한다. 이 변환기는 string·Blob·
 * `bytes()`를 가진 객체만 받고, React Native식 `{ uri, name, type }` 조각은
 * 'Unsupported FormDataPart implementation'으로 거부한다 (iOS 빌드 116 실사고).
 *
 * 기기와 같은 구성 — RN FormData + Expo FormData 패치 + Expo 변환기 — 으로
 * 두 업로드 경로의 본문을 실제로 직렬화해, 조각이 변환기 계약을 지키는지 본다.
 */
import { createApiClient } from '../client';
import { useAuthStore } from '../../store/authStore';

jest.mock('expo-file-system', () => {
  const files: Record<string, { bytes: number[]; type: string }> = {
    'file:///cache/DocumentPicker/notes.txt': {
      bytes: Array.from('hello attachment', (c) => c.charCodeAt(0)),
      type: 'text/plain',
    },
    'file:///cache/ImagePicker/9F2C0A.jpg': {
      bytes: [0xff, 0xd8, 0xff, 0xe0],
      type: 'image/jpeg',
    },
  };
  class File {
    readonly uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    get name(): string {
      return this.uri.split('/').pop() ?? '';
    }
    get type(): string {
      return files[this.uri]?.type ?? '';
    }
    async bytes(): Promise<Uint8Array> {
      const file = files[this.uri];
      if (!file) throw new Error(`missing fixture file: ${this.uri}`);
      return new Uint8Array(file.bytes);
    }
  }
  return { File };
});

const BASE = 'http://test.example';
const BOUNDARY = 'TESTBOUNDARY';

// 기기 런타임은 RN FormData에 Expo 패치를 얹는다 (expo/src/winter/runtime.native.ts).
// jest-expo는 이 패치를 jest.fn()으로 비워 두므로, Expo 자체 테스트처럼 실물을 가져온다.
const { installFormDataPatch } = jest.requireActual('expo/src/winter/FormData');
const { convertFormDataAsync } = require('expo/src/winter/fetch/convertFormData');
const DeviceFormData = require('react-native/Libraries/Network/FormData').default;
installFormDataPatch(DeviceFormData);
const originalFormData = global.FormData;

function mockJsonFetch(body: unknown) {
  const fn = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers({ 'Content-Type': 'application/json' }),
  } as Partial<Response>);
  (global as any).fetch = fn;
  return fn;
}

/** 기기에서 Expo fetch가 보낼 multipart 본문을 그대로 만든다. */
async function serializeSentBody(fetchMock: jest.Mock): Promise<string> {
  const [, init] = fetchMock.mock.calls[0];
  const { body } = await convertFormDataAsync((init as RequestInit).body, BOUNDARY);
  return Buffer.from(body).toString('latin1');
}

function part(headers: string[], content: string): string {
  return `--${BOUNDARY}\r\n${headers.map((h) => `${h}\r\n`).join('')}\r\n${content}\r\n`;
}

beforeEach(() => {
  (global as any).FormData = DeviceFormData;
  useAuthStore.setState({ jwt: 'test-jwt' });
});

afterEach(() => {
  (global as any).FormData = originalFormData;
  jest.restoreAllMocks();
});

describe('upload multipart — Expo fetch 직렬화 계약', () => {
  it('uploadAttachment 본문이 파일 바이트·이름·MIME을 담아 직렬화된다', async () => {
    const fetchMock = mockJsonFetch({ path: '/server/notes.txt' });
    const api = createApiClient(BASE);

    await api.uploadAttachment('sess-1', 'node-1', {
      uri: 'file:///cache/DocumentPicker/notes.txt',
      name: 'meeting-notes.txt',
    });

    expect(await serializeSentBody(fetchMock)).toBe(
      part(['content-disposition: form-data; name="session_id"'], 'sess-1')
        + part(
          [
            'content-disposition: form-data; name="file"; filename="meeting-notes.txt"',
            // 호출자가 MIME을 주지 않으면 파일 시스템이 판정한 값을 쓴다.
            'content-type: text/plain',
          ],
          'hello attachment',
        )
        + `--${BOUNDARY}--\r\n`,
    );
  });

  it('uploadUserBackground 본문은 호출자의 이름·MIME을 우선한다', async () => {
    const fetchMock = mockJsonFetch({ wallpaper: { mode: 'photo' } });
    const api = createApiClient(BASE);

    await api.uploadUserBackground({
      uri: 'file:///cache/ImagePicker/9F2C0A.jpg',
      name: 'IMG_0042.jpg',
      type: 'image/png',
    });

    expect(await serializeSentBody(fetchMock)).toBe(
      part(
        [
          'content-disposition: form-data; name="file"; filename="IMG_0042.jpg"',
          'content-type: image/png',
        ],
        '\xff\xd8\xff\xe0',
      )
        + `--${BOUNDARY}--\r\n`,
    );
  });

  it('판정기 자기 검증: RN식 { uri } 조각은 Expo 변환기가 거부한다', async () => {
    const form = new DeviceFormData();
    form.append('file', { uri: 'file:///cache/ImagePicker/9F2C0A.jpg', name: 'a.jpg', type: 'image/jpeg' });

    await expect(convertFormDataAsync(form, BOUNDARY)).rejects.toThrow(
      'Unsupported FormDataPart implementation',
    );
  });
});
