import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { isRecord } from "@soulstream/wire-schema/json-record";

import { McpCentralError } from "./errors.js";
import type { McpIcon } from "./types.js";

export const MCP_ICON_SYMBOL_NAMES = [
  "book-open",
  "layers",
  "database",
  "search",
  "git-branch",
  "presentation",
  "sparkles",
  "layout-grid",
  "terminal",
  "globe",
  "wrench",
  "plug",
  "users",
  "message-square",
  "file-text",
  "cloud",
  "shield",
  "cpu",
  "bot",
  "code-2",
  "folder",
  "calendar",
  "mail",
  "lock",
] as const;

export const MCP_ICON_COLORS = [
  "node-user",
  "node-response",
  "node-thinking",
  "node-plan",
  "node-tool",
  "node-intervention",
  "node-input-request",
  "node-system",
] as const;

export const MCP_ICON_MAX_BYTES = 262_144;
export const MCP_ICON_MAX_DIMENSION = 512;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;
const SUPPORTED_UPLOAD_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;

export type SupportedUploadMime = (typeof SUPPORTED_UPLOAD_MIMES)[number];

export type DecodedIconImage = {
  readonly mime: SupportedUploadMime;
  readonly body: Buffer;
  readonly width: number;
  readonly height: number;
  readonly content_hash: string;
};

let brandCatalog: ReadonlyMap<string, string> | undefined;

/** simple-icons 카탈로그(slug → #RRGGBB)를 한 번만 읽는다. JS 모듈은 import하지 않는다. */
export function brandIconHexes(): ReadonlyMap<string, string> {
  if (brandCatalog !== undefined) return brandCatalog;
  const require = createRequire(import.meta.url);
  const path = require.resolve("simple-icons/icons.json");
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error("simple-icons/icons.json must contain an array");
  }
  const catalog = new Map<string, string>();
  for (const entry of parsed) {
    if (!isRecord(entry)) continue;
    const slug = entry.slug;
    const hex = entry.hex;
    if (typeof slug !== "string" || typeof hex !== "string") continue;
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) continue;
    catalog.set(slug, `#${hex.toUpperCase()}`);
  }
  brandCatalog = catalog;
  return catalog;
}

export function brandIconHexForSlug(slug: string): string | null {
  return brandIconHexes().get(slug) ?? null;
}

function invalidIcon(message: string): McpCentralError {
  return new McpCentralError("MCP_INVALID_ICON", 400, message);
}

function invalidIconUpload(message: string): McpCentralError {
  return new McpCentralError("MCP_INVALID_ICON_UPLOAD", 400, message);
}

/**
 * 서버 아이콘 입력 네 꼴을 검사한다. brand의 hex는 클라이언트가 아니라
 * 카탈로그 정본에서 서버가 확정한다. null은 지정 없음이다.
 */
export function validateIcon(input: unknown): McpIcon | null {
  if (input === null || input === undefined) return null;
  if (!isRecord(input)) throw invalidIcon("icon must be an object or null");
  switch (input.kind) {
    case "brand": {
      if (typeof input.slug !== "string" || input.slug.length === 0) {
        throw invalidIcon("brand icon requires a slug");
      }
      const hex = brandIconHexForSlug(input.slug);
      if (hex === null) throw invalidIcon(`unknown brand icon slug: ${input.slug}`);
      return { kind: "brand", slug: input.slug, hex };
    }
    case "symbol": {
      if (
        typeof input.name !== "string"
        || !(MCP_ICON_SYMBOL_NAMES as readonly string[]).includes(input.name)
      ) {
        throw invalidIcon("unknown symbol icon name");
      }
      if (
        typeof input.color !== "string"
        || !(MCP_ICON_COLORS as readonly string[]).includes(input.color)
      ) {
        throw invalidIcon("unknown symbol icon color");
      }
      return { kind: "symbol", name: input.name, color: input.color };
    }
    case "upload": {
      if (typeof input.ref !== "string" || !UUID_PATTERN.test(input.ref)) {
        throw invalidIcon("upload icon requires a valid ref");
      }
      if (typeof input.content_hash !== "string" || !CONTENT_HASH_PATTERN.test(input.content_hash)) {
        throw invalidIcon("upload icon requires a valid content_hash");
      }
      return { kind: "upload", ref: input.ref, content_hash: input.content_hash };
    }
    case null:
    case undefined:
      return null;
    default:
      throw invalidIcon("unknown icon kind");
  }
}

function readPngSize(body: Buffer): { width: number; height: number } | null {
  if (body.length < 24) return null;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let index = 0; index < signature.length; index += 1) {
    if (body[index] !== signature[index]) return null;
  }
  if (body.subarray(12, 16).toString("ascii") !== "IHDR") return null;
  return { width: body.readUInt32BE(16), height: body.readUInt32BE(20) };
}

const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function readJpegSize(body: Buffer): { width: number; height: number } | null {
  if (body.length < 4 || body[0] !== 0xff || body[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < body.length) {
    if (body[offset] !== 0xff) return null;
    const marker = body[offset + 1];
    if (marker === undefined) return null;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    if (offset + 4 > body.length) return null;
    const length = body.readUInt16BE(offset + 2);
    if (length < 2) return null;
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (offset + 9 > body.length) return null;
      return { height: body.readUInt16BE(offset + 5), width: body.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

function readWebpSize(body: Buffer): { width: number; height: number } | null {
  if (body.length < 30) return null;
  if (body.subarray(0, 4).toString("ascii") !== "RIFF") return null;
  if (body.subarray(8, 12).toString("ascii") !== "WEBP") return null;
  const chunk = body.subarray(12, 16).toString("ascii");
  if (chunk === "VP8 ") {
    if (body[23] !== 0x9d || body[24] !== 0x01 || body[25] !== 0x2a) return null;
    return { width: body.readUInt16LE(26) & 0x3fff, height: body.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (body[20] !== 0x2f) return null;
    const bits = body.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    return { width: body.readUIntLE(24, 3) + 1, height: body.readUIntLE(27, 3) + 1 };
  }
  return null;
}

/**
 * base64 아이콘 업로드를 검사한다. PNG/JPEG/WebP만 받고 SVG/GIF는 거절한다.
 * 파일 크기는 256 KiB, 가로·세로는 각각 1~512다.
 */
export function parseIconUpload(input: unknown): DecodedIconImage {
  if (!isRecord(input)) throw invalidIconUpload("request body must be an object");
  const data = input.data_base64;
  if (typeof data !== "string" || data.length === 0) {
    throw invalidIconUpload("data_base64 is required");
  }
  const body = Buffer.from(data, "base64");
  if (
    body.length === 0
    || body.toString("base64").replace(/=+$/, "") !== data.replace(/=+$/, "")
  ) {
    throw invalidIconUpload("data_base64 is invalid");
  }
  if (body.length > MCP_ICON_MAX_BYTES) {
    throw invalidIconUpload("icon must not exceed 256 KiB");
  }

  let mime: SupportedUploadMime;
  let size: { width: number; height: number } | null;
  const png = readPngSize(body);
  if (png !== null) {
    mime = "image/png";
    size = png;
  } else {
    const jpeg = readJpegSize(body);
    if (jpeg !== null) {
      mime = "image/jpeg";
      size = jpeg;
    } else {
      const webp = readWebpSize(body);
      if (webp === null) {
        throw invalidIconUpload("icon must be a PNG, JPEG or WebP image");
      }
      mime = "image/webp";
      size = webp;
    }
  }
  const { width, height } = size;
  if (
    width < 1 || width > MCP_ICON_MAX_DIMENSION
    || height < 1 || height > MCP_ICON_MAX_DIMENSION
  ) {
    throw invalidIconUpload("icon dimensions must be between 1 and 512 pixels");
  }

  const contentHash = createHash("sha256").update(body).digest("hex");
  if (input.sha256 !== undefined) {
    if (typeof input.sha256 !== "string" || input.sha256 !== contentHash) {
      throw invalidIconUpload("sha256 does not match icon bytes");
    }
  }
  return { mime, body, width, height, content_hash: contentHash };
}

/** 업로드 참조가 없거나 다른 서버 소유일 때 쓰는 오류. */
export function invalidIconUploadError(message: string): McpCentralError {
  return invalidIconUpload(message);
}
