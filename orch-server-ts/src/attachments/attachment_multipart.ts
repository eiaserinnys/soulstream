import { Buffer } from "node:buffer";

import type { FastifyRequest } from "fastify";

export type MultipartFile = {
  filename: string;
  contentType: string;
  content: Buffer;
};

export type MultipartForm = {
  fields: Map<string, string>;
  file: MultipartFile;
};

type MultipartParseResult =
  | { ok: true; value: MultipartForm }
  | { ok: false; message: string; statusCode?: number };

export function parseMultipartForm(request: FastifyRequest): MultipartParseResult {
  if (!Buffer.isBuffer(request.body)) {
    return { ok: false, message: "multipart body is required", statusCode: 400 };
  }
  const boundary = multipartBoundary(request.headers["content-type"]);
  if (boundary === undefined) {
    return { ok: false, message: "multipart boundary is required", statusCode: 400 };
  }
  const parsed = parseMultipartBuffer(request.body, boundary);
  if (!parsed.ok) return parsed;
  const file = parsed.value.file;
  if (file === undefined) {
    return { ok: false, message: "file is required", statusCode: 400 };
  }
  return { ok: true, value: { fields: parsed.value.fields, file } };
}

function multipartBoundary(contentType: string | string[] | undefined): string | undefined {
  const value = Array.isArray(contentType) ? contentType[0] : contentType;
  const match = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;]+))/i.exec(value ?? "");
  return match?.[1] ?? match?.[2]?.trim();
}

function parseMultipartBuffer(
  body: Buffer,
  boundary: string,
): { ok: true; value: { fields: Map<string, string>; file?: MultipartFile } } | { ok: false; message: string; statusCode?: number } {
  const fields = new Map<string, string>();
  let file: MultipartFile | undefined;
  const delimiter = Buffer.from(`--${boundary}`);
  let cursor = body.indexOf(delimiter);
  while (cursor >= 0 && body.subarray(cursor, cursor + delimiter.length).equals(delimiter)) {
    cursor += delimiter.length;
    if (body.subarray(cursor, cursor + 2).toString("ascii") === "--") break;
    cursor = skipLineBreak(body, cursor);
    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), cursor);
    if (headerEnd < 0) {
      return { ok: false, message: "malformed multipart headers", statusCode: 400 };
    }
    const headers = parsePartHeaders(body.subarray(cursor, headerEnd).toString("utf8"));
    const contentStart = headerEnd + 4;
    const next = findNextBoundary(body, contentStart, boundary);
    if (next === undefined) {
      return { ok: false, message: "malformed multipart body", statusCode: 400 };
    }
    const disposition = parseContentDisposition(headers.get("content-disposition") ?? "");
    if (disposition.name !== undefined) {
      const content = body.subarray(contentStart, next.markerStart);
      if (disposition.name === "file") {
        file = {
          filename: disposition.filename === undefined || disposition.filename === "" ? "unnamed" : disposition.filename,
          contentType: headers.get("content-type") ?? "application/octet-stream",
          content,
        };
      } else {
        fields.set(disposition.name, content.toString("utf8"));
      }
    }
    cursor = next.delimiterStart;
  }
  return { ok: true, value: { fields, file } };
}

function skipLineBreak(body: Buffer, cursor: number): number {
  if (body[cursor] === 13 && body[cursor + 1] === 10) return cursor + 2;
  if (body[cursor] === 10) return cursor + 1;
  return cursor;
}

function findNextBoundary(
  body: Buffer,
  start: number,
  boundary: string,
): { markerStart: number; delimiterStart: number } | undefined {
  const crlfMarker = Buffer.from(`\r\n--${boundary}`);
  const lfMarker = Buffer.from(`\n--${boundary}`);
  const crlfIndex = body.indexOf(crlfMarker, start);
  const lfIndex = body.indexOf(lfMarker, start);
  if (crlfIndex >= 0 && (lfIndex < 0 || crlfIndex <= lfIndex)) {
    return { markerStart: crlfIndex, delimiterStart: crlfIndex + 2 };
  }
  if (lfIndex >= 0) return { markerStart: lfIndex, delimiterStart: lfIndex + 1 };
  return undefined;
}

function parsePartHeaders(rawHeaders: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of rawHeaders.split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    headers.set(line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim());
  }
  return headers;
}

function parseContentDisposition(value: string): { name?: string; filename?: string } {
  return {
    name: parameterValue(value, "name"),
    filename: parameterValue(value, "filename"),
  };
}

function parameterValue(value: string, name: string): string | undefined {
  const quoted = new RegExp(`(?:^|;)\\s*${name}="([^"]*)"`).exec(value);
  if (quoted?.[1] !== undefined) return quoted[1];
  const unquoted = new RegExp(`(?:^|;)\\s*${name}=([^;]+)`).exec(value);
  return unquoted?.[1]?.trim();
}
