export const TEXT_PREVIEW_MAX_BYTES = 1_048_576;

export type AttachmentTextPreviewErrorCode =
  | "TEXT_PREVIEW_INVALID_RESPONSE"
  | "TEXT_PREVIEW_UNSUPPORTED_ENCODING";

export class AttachmentTextPreviewError extends Error {
  constructor(
    readonly code: AttachmentTextPreviewErrorCode,
    readonly status: number | null = null,
  ) {
    super(code);
    this.name = "AttachmentTextPreviewError";
  }
}

export interface AttachmentTextPreview {
  text: string;
  truncated: boolean;
  bytesRead: number;
}

export async function readAttachmentText(input: {
  url: string;
  byteSize: number | null;
  signal?: AbortSignal;
}): Promise<AttachmentTextPreview> {
  const byteSize = input.byteSize ?? await readRemoteSize(input.url, input.signal);
  validateByteSize(byteSize);
  input.signal?.throwIfAborted();
  if (byteSize === 0) return { text: "", truncated: false, bytesRead: 0 };

  const expectedBytes = Math.min(byteSize, TEXT_PREVIEW_MAX_BYTES);
  const response = await fetch(input.url, {
    credentials: "same-origin",
    headers: { Range: `bytes=0-${expectedBytes - 1}` },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const reader = response.body?.getReader();
  const removeAbortListener = reader === undefined ? () => {} : cancelOnAbort(reader, input.signal);
  let bytesRead = 0;
  let text = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    validateRangeResponse(response, byteSize, expectedBytes);
    if (reader === undefined) throw invalidResponse();
    while (true) {
      input.signal?.throwIfAborted();
      const result = await reader.read();
      input.signal?.throwIfAborted();
      if (result.done) break;
      if (result.value.byteLength > expectedBytes - bytesRead) {
        throw invalidResponse(response.status);
      }
      bytesRead += result.value.byteLength;
      text += decodeChunk(decoder, result.value);
    }
    if (bytesRead !== expectedBytes) throw invalidResponse(response.status);
    const truncated = byteSize > TEXT_PREVIEW_MAX_BYTES;
    if (!truncated) text += decodeFinal(decoder);
    return { text, truncated, bytesRead };
  } catch (error) {
    await reader?.cancel(error).catch(() => undefined);
    input.signal?.throwIfAborted();
    throw error;
  } finally {
    removeAbortListener();
  }
}

async function readRemoteSize(url: string, signal?: AbortSignal): Promise<number> {
  const response = await fetch(url, { credentials: "same-origin", headers: { Range: "bytes=0-0" }, signal });
  const header = response.headers.get("Content-Range");
  const match = response.status === 206 ? /^bytes 0-0\/(\d+)$/.exec(header ?? "") : response.status === 416 ? /^bytes \*\/(0)$/.exec(header ?? "") : null;
  await response.body?.cancel();
  if (!match) throw invalidResponse(response.status);
  return Number(match[1]);
}

export async function readLocalAttachmentText(
  file: File,
  signal?: AbortSignal,
): Promise<AttachmentTextPreview> {
  signal?.throwIfAborted();
  if (file.size === 0) return { text: "", truncated: false, bytesRead: 0 };
  const bytesRead = Math.min(file.size, TEXT_PREVIEW_MAX_BYTES);
  const bytes = new Uint8Array(await file.slice(0, bytesRead).arrayBuffer());
  signal?.throwIfAborted();
  const truncated = file.size > TEXT_PREVIEW_MAX_BYTES;
  return {
    text: decodeBytes(bytes, truncated),
    truncated,
    bytesRead: bytes.byteLength,
  };
}

function validateByteSize(byteSize: number): void {
  if (!Number.isSafeInteger(byteSize) || byteSize < 0) throw invalidResponse();
}

function validateRangeResponse(response: Response, byteSize: number, expectedBytes: number): void {
  if (!response.ok || response.status !== 206) throw invalidResponse(response.status);
  const range = response.headers.get("Content-Range")?.match(/^bytes (\d+)-(\d+)\/(\d+)$/) ?? null;
  const expectedEnd = expectedBytes - 1;
  if (range === null
      || Number(range[1]) !== 0
      || Number(range[2]) !== expectedEnd
      || Number(range[3]) !== byteSize
      || Number(response.headers.get("Content-Length")) !== expectedBytes) {
    throw invalidResponse(response.status);
  }
  const contentEncoding = response.headers.get("Content-Encoding");
  if (contentEncoding !== null && contentEncoding.toLowerCase() !== "identity") {
    throw new AttachmentTextPreviewError("TEXT_PREVIEW_UNSUPPORTED_ENCODING", response.status);
  }
}

function decodeBytes(bytes: Uint8Array, truncated: boolean): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = decodeChunk(decoder, bytes);
  if (!truncated) text += decodeFinal(decoder);
  return text;
}

function decodeChunk(decoder: TextDecoder, bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes, { stream: true });
  } catch {
    throw new AttachmentTextPreviewError("TEXT_PREVIEW_UNSUPPORTED_ENCODING");
  }
}

function decodeFinal(decoder: TextDecoder): string {
  try {
    return decoder.decode();
  } catch {
    throw new AttachmentTextPreviewError("TEXT_PREVIEW_UNSUPPORTED_ENCODING");
  }
}

function cancelOnAbort(reader: ReadableStreamDefaultReader<Uint8Array>, signal?: AbortSignal): () => void {
  if (signal === undefined) return () => {};
  const onAbort = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

function invalidResponse(status: number | null = null): AttachmentTextPreviewError {
  return new AttachmentTextPreviewError("TEXT_PREVIEW_INVALID_RESPONSE", status);
}
