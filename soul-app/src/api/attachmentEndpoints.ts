import type { ApiRequestContext } from './clientCore';
import { File } from 'expo-file-system';
import { appendNativeUploadFile, type NativeUploadFile } from './nativeUpload';
import { NATIVE_MULTIPART_THRESHOLD_BYTES, uploadNativeMultipart } from './nativeMultipartUpload';
import type { AttachmentDescriptor, AttachmentReadContext } from '../../../packages/wire-schema/src/attachments';
import {
  attachmentContentUrl,
  attachmentMediaMimeType,
  MAX_ATTACHMENT_TEXT_BYTES,
  type AttachmentMediaContent,
} from '../lib/attachment-view';
import { parseExactAttachmentLink } from '../lib/attachment-link-view';

export interface AttachmentMetadataResponse {
  descriptor: AttachmentDescriptor;
  upload_status: string;
}

export type AttachmentReadErrorKind = 'unauthorized' | 'denied' | 'not-found' | 'conflict' | 'retryable' | 'preview-failed';

export class AttachmentReadError extends Error {
  readonly name = 'AttachmentReadError';

  constructor(readonly kind: AttachmentReadErrorKind, readonly status?: number) {
    super(`Attachment preview failed${status === undefined ? '' : ` (HTTP ${status})`}`);
  }
}

export function createAttachmentEndpoints({
  base,
  authFetch,
  readJson,
}: ApiRequestContext) {
  const readBoundedAttachmentText = async (
    url: string,
    signal?: AbortSignal,
  ): Promise<{ text: string; truncated: boolean }> => {
    let response: Response;
    try {
      response = await authFetch(url, {
        headers: { Range: `bytes=0-${MAX_ATTACHMENT_TEXT_BYTES - 1}` },
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
      throw new AttachmentReadError('retryable');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw attachmentReadError(response.status);
    }
    try {
      return await readBoundedText(response, MAX_ATTACHMENT_TEXT_BYTES);
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
      if (error instanceof AttachmentReadError) throw error;
      throw new AttachmentReadError('preview-failed');
    }
  };

  const readAuthenticatedAttachmentMedia = async (
    url: string,
    signal?: AbortSignal,
    options?: { mimeType?: string | null; name?: string },
  ): Promise<AttachmentMediaContent> => {
    let response: Response;
    try {
      response = await authFetch(url, signal === undefined ? {} : { signal });
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
      throw new AttachmentReadError('retryable');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw attachmentReadError(response.status);
    }

    const responseMimeType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() || null;
    const mimeType = responseMimeType?.startsWith('video/') || responseMimeType?.startsWith('audio/')
      ? responseMimeType
      : attachmentMediaMimeType({ mimeType: options?.mimeType ?? null, name: options?.name ?? '' });
    if (!mimeType) throw new AttachmentReadError('preview-failed', response.status);

    const canCreateObjectUrl = typeof URL !== 'undefined'
      && typeof URL.createObjectURL === 'function'
      && typeof Blob !== 'undefined';
    if (canCreateObjectUrl && typeof response.blob === 'function') {
      let blob: Blob;
      try {
        blob = await response.blob();
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
        throw new AttachmentReadError('retryable');
      }
      const normalizedMimeType = mimeType.split(';', 1)[0].trim().toLowerCase();
      const normalizedBlob = blob.type.toLowerCase() === normalizedMimeType
        ? blob
        : new Blob([blob], { type: mimeType });
      return { uri: URL.createObjectURL(normalizedBlob), mimeType };
    }

    let buffer: ArrayBuffer;
    try {
      if (typeof response.arrayBuffer === 'function') buffer = await response.arrayBuffer();
      else if (typeof response.blob === 'function') buffer = await (await response.blob()).arrayBuffer();
      else throw new AttachmentReadError('preview-failed', response.status);
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
      if (error instanceof AttachmentReadError) throw error;
      throw new AttachmentReadError('retryable');
    }
    return { uri: `data:${mimeType};base64,${arrayBufferToBase64(buffer)}`, mimeType };
  };

  return {
    getAttachmentMetadata: async (
      id: string,
      context: AttachmentReadContext,
      signal?: AbortSignal,
    ): Promise<AttachmentMetadataResponse> => {
      const query = contextQuery(context);
      const url = `${base}/api/attachments/${encodeURIComponent(id)}${query ? `?${query}` : ''}`;
      const response = await authFetch(url, signal === undefined ? {} : { signal });
      return readJson<AttachmentMetadataResponse>(response, 'getAttachmentMetadata');
    },
    readAttachmentText: (
      id: string,
      context: AttachmentReadContext,
      signal?: AbortSignal,
    ): Promise<{ text: string; truncated: boolean }> =>
      readBoundedAttachmentText(`${base}${attachmentContentUrl(id, context)}`, signal),
    readAttachmentMedia: (
      id: string,
      context: AttachmentReadContext,
      signal?: AbortSignal,
      options?: { mimeType?: string | null; name?: string },
    ): Promise<AttachmentMediaContent> =>
      readAuthenticatedAttachmentMedia(`${base}${attachmentContentUrl(id, context)}`, signal, options),
    // Legacy files are not addressable by ID; read the original /api/attachments/files URL instead.
    readLegacyAttachmentText: async (
      href: string,
      signal?: AbortSignal,
    ): Promise<{ text: string; truncated: boolean }> => {
      if (parseExactAttachmentLink(href, base)?.kind !== 'legacy') {
        throw new AttachmentReadError('preview-failed');
      }
      return readBoundedAttachmentText(new URL(href, base).href, signal);
    },
    readLegacyAttachmentMedia: async (
      href: string,
      signal?: AbortSignal,
      options?: { mimeType?: string | null; name?: string },
    ): Promise<AttachmentMediaContent> => {
      if (parseExactAttachmentLink(href, base)?.kind !== 'legacy') {
        throw new AttachmentReadError('preview-failed');
      }
      return readAuthenticatedAttachmentMedia(new URL(href, base).href, signal, options);
    },
    // 첨부 파일 업로드 (multipart). multipart Content-Type은 boundary 때문에 fetch가 자동 부착한다.
    uploadAttachment: async (
      sessionId: string,
      nodeId: string,
      file: NativeUploadFile,
      options: { folderId?: string; signal?: AbortSignal } = {},
    ): Promise<{
      path?: string;
      filename?: string;
      [k: string]: any;
    }> => {
      const localFile = new File(file.uri);
      if (!localFile.exists) throw new Error('[uploadAttachment] 첨부 파일을 찾을 수 없습니다');
      const size = localFile.size;
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error('[uploadAttachment] 첨부 파일 크기를 확인할 수 없습니다');
      }
      if (size >= NATIVE_MULTIPART_THRESHOLD_BYTES) {
        return uploadNativeMultipart({
          base,
          authFetch,
          readJson,
          sessionId,
          nodeId,
          file,
          folderId: options.folderId,
          signal: options.signal,
        });
      }

      const form = new FormData();
      form.append('session_id', sessionId);
      if (options.folderId !== undefined) form.append('folder_id', options.folderId);
      appendNativeUploadFile(form, 'file', file);
      return authFetch(
        `${base}/api/attachments/sessions?nodeId=${encodeURIComponent(nodeId)}`,
        {
          method: 'POST',
          body: form,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
      ).then((r) => readJson(r, 'uploadAttachment'));
    },
  };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const value = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    encoded += alphabet[(value >> 18) & 63]
      + alphabet[(value >> 12) & 63]
      + (second === undefined ? '=' : alphabet[(value >> 6) & 63])
      + (third === undefined ? '=' : alphabet[value & 63]);
  }
  return encoded;
}

function contextQuery(context: AttachmentReadContext): string {
  if (context.type === 'owner') return '';
  return new URLSearchParams({ context_type: context.type, context_id: context.id }).toString();
}

function attachmentReadError(status: number): AttachmentReadError {
  if (status === 401) return new AttachmentReadError('unauthorized', status);
  if (status === 403) return new AttachmentReadError('denied', status);
  if (status === 404) return new AttachmentReadError('not-found', status);
  if (status === 409) return new AttachmentReadError('conflict', status);
  if (status >= 500) return new AttachmentReadError('retryable', status);
  return new AttachmentReadError('preview-failed', status);
}

async function readBoundedText(response: Response, maximumBytes: number): Promise<{ text: string; truncated: boolean }> {
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    const contentLength = numericHeader(response.headers.get('content-length'));
    if (contentLength !== null && contentLength > maximumBytes) {
      throw new AttachmentReadError('preview-failed', response.status);
    }
    // RN's whatwg-fetch Response exposes no body stream, but text() still returns
    // the real payload; an empty GET yields ''. Always read the text.
    const text = await response.text();
    const bytes = new TextEncoder().encode(text);
    const truncated = bytes.byteLength > maximumBytes || rangeExceedsLimit(response, maximumBytes);
    const limited = bytes.subarray(0, maximumBytes);
    const decoder = new TextDecoder('utf-8');
    return {
      text: decoder.decode(limited, truncated ? { stream: true } : undefined),
      truncated,
    };
  }

  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let text = '';
  let bytesRead = 0;
  let truncated = rangeExceedsLimit(response, maximumBytes);
  try {
    while (bytesRead < maximumBytes) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const remaining = maximumBytes - bytesRead;
      if (chunk.value.byteLength > remaining) {
        text += decoder.decode(chunk.value.subarray(0, remaining), { stream: true });
        bytesRead += remaining;
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      text += decoder.decode(chunk.value, { stream: true });
      bytesRead += chunk.value.byteLength;
    }

    if (!truncated && bytesRead === maximumBytes) {
      const next = await reader.read();
      if (!next.done && next.value.byteLength > 0) {
        truncated = true;
        await reader.cancel().catch(() => undefined);
      }
    }
    const contentLength = numericHeader(response.headers.get('content-length'));
    if (contentLength !== null && contentLength > bytesRead) truncated = true;
    if (!truncated) text += decoder.decode();
    return { text, truncated };
  } finally {
    reader.releaseLock();
  }
}

function rangeExceedsLimit(response: Response, maximumBytes: number): boolean {
  if (response.status !== 206) return false;
  const value = response.headers.get('content-range');
  const match = value?.match(/^bytes\s+\d+-(\d+)\/(\d+|\*)$/i);
  if (!match) return true;
  const end = Number(match[1]);
  const total = match[2] === '*' ? null : Number(match[2]);
  return (Number.isFinite(total) && total !== null && total > end + 1)
    || end + 1 > maximumBytes;
}

function numericHeader(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
