import path from "node:path";

import type { AttachmentDescriptor } from "@soulstream/wire-schema/attachments";

const SAFE_INLINE_RASTER_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);
const SAFE_INLINE_MEDIA_MIME_TYPES = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/ogg",
  "video/x-m4v",
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/flac",
  "audio/x-flac",
  "audio/mp4",
  "audio/x-m4a",
  "audio/m4a",
  "audio/aac",
  "audio/ogg",
  "audio/webm",
  "audio/opus",
]);
const MEDIA_MIME_TYPES_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/mp4",
  ".ogv": "video/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
};
const SAFE_TEXT_PREVIEW_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "application/json",
  "text/javascript",
  "application/javascript",
  "text/typescript",
  "application/typescript",
  "text/x-python",
  "text/x-script.python",
  "text/x-shellscript",
  "text/x-csrc",
  "text/x-c++src",
  "text/x-java-source",
  "text/css",
  "text/csv",
]);
const MIME_TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";

export type ParsedAttachmentRange = {
  readonly start: number;
  readonly end: number;
  readonly length: number;
  readonly header: string;
};

export function parseSingleRange(value: string, size: number): ParsedAttachmentRange | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (match === null || (match[1] === "" && match[2] === "")) return null;
  let start: number;
  let end: number;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || size === 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
    if (
      !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || size === 0 ||
      start > end || start >= size
    ) return null;
    end = Math.min(end, size - 1);
  }
  const length = end - start + 1;
  return { start, end, length, header: `bytes=${start}-${end}` };
}

export function normalizedMimeType(value: string): string {
  return value.trim().toLowerCase().split(";", 1)[0] ?? "";
}

export function previewInfo(
  mimeType: string,
): { kind: AttachmentDescriptor["preview_kind"]; mimeType: string | null } {
  if (SAFE_INLINE_RASTER_MIME_TYPES.has(mimeType)) return { kind: "image", mimeType };
  if (mimeType === "text/markdown" || mimeType === "text/html") {
    return { kind: "text", mimeType };
  }
  if (SAFE_TEXT_PREVIEW_MIME_TYPES.has(mimeType)) {
    return { kind: "text", mimeType: "text/plain" };
  }
  return { kind: "info", mimeType: null };
}

export function responseHeaders(
  asset: { readonly originalName: string; readonly mimeType: string },
  download: boolean,
  input: {
    readonly contentLength: number;
    readonly contentRange?: string;
    readonly etag?: string | null;
    readonly lastModified?: string | null;
  },
): Headers {
  const baseMimeType = normalizedMimeType(asset.mimeType);
  const inferredMimeType = baseMimeType === "" || baseMimeType === "application/octet-stream"
    ? inferMediaMimeTypeFromName(asset.originalName)
    : null;
  const effectiveBaseMimeType = inferredMimeType ?? baseMimeType;
  const contentType = inferredMimeType ?? responseMimeType(asset.mimeType);
  const inline = !download && (
    SAFE_INLINE_RASTER_MIME_TYPES.has(effectiveBaseMimeType) ||
    effectiveBaseMimeType === "text/plain" ||
    SAFE_INLINE_MEDIA_MIME_TYPES.has(effectiveBaseMimeType)
  );
  const headers = new Headers({
    "Content-Type": contentType,
    "Content-Length": String(input.contentLength),
    "Content-Disposition": `${inline ? "inline" : "attachment"}; ${contentDispositionFilename(asset.originalName)}`,
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes",
  });
  if (input.contentRange !== undefined) headers.set("Content-Range", input.contentRange);
  if (input.etag) headers.set("ETag", input.etag);
  if (input.lastModified) headers.set("Last-Modified", input.lastModified);
  return headers;
}

function inferMediaMimeTypeFromName(originalName: string): string | null {
  const extension = path.posix.extname(originalName.replace(/\\/g, "/")).toLowerCase();
  return MEDIA_MIME_TYPES_BY_EXTENSION[extension] ?? null;
}

export function parseContentLength(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

export function safeHeader(value: string | null): string | null {
  return value !== null && !/[\r\n]/.test(value) ? value : null;
}

function responseMimeType(value: string): string {
  const mimeType = value.trim();
  if (/[\u0000-\u001f\u007f]/.test(value)) return "application/octet-stream";
  const parameter = `(?:${MIME_TOKEN}|"(?:[\\x20-\\x21\\x23-\\x5b\\x5d-\\x7e]|\\\\[\\x20-\\x7e])*?")`;
  const pattern = new RegExp(
    `^${MIME_TOKEN}/${MIME_TOKEN}(?: *; *${MIME_TOKEN} *= *${parameter})*$`,
  );
  return pattern.test(mimeType) ? mimeType : "application/octet-stream";
}

function contentDispositionFilename(value: string): string {
  const basename = path.posix.basename(value.replace(/\\/g, "/")).replace(/[\r\n\0]/g, "").trim();
  const filename = basename === "" || basename === "." || basename === ".." ? "attachment" : basename;
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const fallback = ascii.trim() === "" ? "attachment" : ascii;
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
