import { File, FileMode } from 'expo-file-system';
import type { ApiRequestContext } from './clientCore';
import type { NativeUploadFile } from './nativeUpload';

export const NATIVE_MULTIPART_THRESHOLD_BYTES = 64 * 1024 ** 2;

const PART_SIZE = 16 * 1024 ** 2;
const MAX_FILE_SIZE = 5 * 1024 ** 3;

type MultipartPartUrl = {
  partNumber: number;
  url: string;
};

type MultipartInitResponse = {
  ticket: string;
  partSize: number;
  parts: MultipartPartUrl[];
};

export type NativeMultipartUploadResult = {
  path: string;
  filename: string;
  size: number;
  content_type: string;
};

export async function uploadNativeMultipart(input: {
  base: string;
  authFetch: ApiRequestContext['authFetch'];
  readJson: ApiRequestContext['readJson'];
  sessionId: string;
  nodeId: string;
  file: NativeUploadFile;
  folderId?: string;
  signal?: AbortSignal;
}): Promise<NativeMultipartUploadResult> {
  const localFile = new File(input.file.uri);
  if (!localFile.exists) throw uploadError('첨부 파일을 찾을 수 없습니다');
  const size = localFile.size;
  if (!Number.isSafeInteger(size) || size < NATIVE_MULTIPART_THRESHOLD_BYTES || size > MAX_FILE_SIZE) {
    throw uploadError('대용량 첨부 파일 크기가 올바르지 않습니다 (64MiB 이상 5GiB 이하)');
  }
  throwIfAborted(input.signal);

  const base = input.base.replace(/\/$/, '');
  const query = `?nodeId=${encodeURIComponent(input.nodeId)}`;
  const initUrl = `${base}/api/attachments/sessions/multipart/init${query}`;
  const completeUrl = `${base}/api/attachments/sessions/multipart/complete${query}`;
  const abortUrl = `${base}/api/attachments/sessions/multipart/abort${query}`;
  const putController = new AbortController();
  const abortPuts = () => putController.abort(input.signal?.reason);
  input.signal?.addEventListener('abort', abortPuts, { once: true });

  let ticket: string | undefined;
  let committed = false;
  let handle: ReturnType<File['open']> | undefined;

  try {
    const initResponse = await input.authFetch(initUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: input.sessionId,
        ...(input.folderId === undefined ? {} : { folder_id: input.folderId }),
        filename: input.file.name || localFile.name,
        size,
        content_type: input.file.type || localFile.type || 'application/octet-stream',
      }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const init = await input.readJson<MultipartInitResponse>(initResponse, 'uploadAttachment');
    if (!init || typeof init.ticket !== 'string' || init.ticket.length === 0) {
      throw uploadError('대용량 첨부 업로드 ticket이 없습니다');
    }
    ticket = init.ticket;
    const parts = validateParts(init, size);
    throwIfAborted(input.signal);

    handle = localFile.open(FileMode.ReadOnly);
    const uploadedParts: Array<{ partNumber: number; etag: string }> = [];
    for (let index = 0; index < parts.length; index += 2) {
      throwIfAborted(input.signal);
      const batch = parts.slice(index, index + 2).map((part) => {
        const offset = (part.partNumber - 1) * PART_SIZE;
        const length = Math.min(PART_SIZE, size - offset);
        const bytes = handle!.readBytes(length);
        if (bytes.byteLength !== length) throw uploadError('첨부 파일 크기가 읽은 내용과 다릅니다');
        return { part, bytes };
      });
      const results = await Promise.all(batch.map(async ({ part, bytes }) => {
        const response = await fetch(part.url, {
          method: 'PUT',
          body: bytes,
          signal: putController.signal,
        });
        if (!response.ok) throw uploadError(`첨부 part ${part.partNumber} 업로드 실패 (HTTP ${response.status})`);
        const etag = response.headers.get('etag');
        if (!etag) throw uploadError(`첨부 part ${part.partNumber} 응답에 ETag가 없습니다`);
        return { partNumber: part.partNumber, etag };
      }));
      uploadedParts.push(...results);
    }

    handle.close();
    handle = undefined;
    const completeResponse = await input.authFetch(completeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ticket,
        parts: uploadedParts.sort((left, right) => left.partNumber - right.partNumber),
      }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    committed = completeResponse.ok;
    const result = await input.readJson<unknown>(completeResponse, 'uploadAttachment');
    return validateUploadResult(result);
  } catch (error) {
    putController.abort();
    if (ticket && !committed) {
      await input.authFetch(abortUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket }),
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    input.signal?.removeEventListener('abort', abortPuts);
    handle?.close();
  }
}

function validateParts(init: MultipartInitResponse, size: number): MultipartPartUrl[] {
  if (init.partSize !== PART_SIZE || !Array.isArray(init.parts)) {
    throw uploadError('대용량 첨부 업로드 part 설정이 올바르지 않습니다');
  }
  const expectedCount = Math.ceil(size / PART_SIZE);
  if (init.parts.length !== expectedCount) throw uploadError('대용량 첨부 업로드 part 개수가 올바르지 않습니다');
  const parts = [...init.parts].sort((left, right) => left.partNumber - right.partNumber);
  for (let index = 0; index < expectedCount; index += 1) {
    const part = parts[index];
    if (part.partNumber !== index + 1 || typeof part.url !== 'string' || part.url.length === 0) {
      throw uploadError('대용량 첨부 업로드 part 정보가 올바르지 않습니다');
    }
  }
  return parts;
}

function validateUploadResult(value: unknown): NativeMultipartUploadResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw uploadError('대용량 첨부 업로드 응답이 올바르지 않습니다');
  }
  const result = value as Record<string, unknown>;
  if (typeof result.path !== 'string' || result.path.length === 0
    || typeof result.filename !== 'string'
    || typeof result.size !== 'number'
    || typeof result.content_type !== 'string') {
    throw uploadError('대용량 첨부 업로드 경로 응답이 올바르지 않습니다');
  }
  return result as NativeMultipartUploadResult;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? uploadError('첨부 업로드가 취소되었습니다');
}

function uploadError(message: string): Error {
  return new Error(`[uploadAttachment] ${message}`);
}
