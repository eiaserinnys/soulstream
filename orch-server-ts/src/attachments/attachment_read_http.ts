import path from "node:path";

import type { AttachmentDescriptor } from "@soulstream/wire-schema/attachments";

const SAFE_INLINE_RASTER_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);

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
  if (mimeType === "text/plain" || mimeType === "text/markdown" || mimeType === "application/json") {
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
  const mimeType = responseMimeType(asset.mimeType);
  const inline = !download && (SAFE_INLINE_RASTER_MIME_TYPES.has(mimeType) || mimeType === "text/plain");
  const headers = new Headers({
    "Content-Type": mimeType,
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

export function parseContentLength(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

export function safeHeader(value: string | null): string | null {
  return value !== null && !/[\r\n]/.test(value) ? value : null;
}

function responseMimeType(value: string): string {
  const normalized = normalizedMimeType(value);
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(normalized)
    ? normalized
    : "application/octet-stream";
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
