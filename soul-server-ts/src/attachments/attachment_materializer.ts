import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import * as path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { AttachmentDescriptor } from "@soulstream/wire-schema/attachments";
import type { OrchProxyConfig } from "../mcp/runtime.js";
import { isPathUnderBase, sanitizeOriginalFilename } from "./file_manager.js";
import { getImageAttachmentMediaType } from "./image_media.js";

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024 * 1024;
const IMAGE_SUFFIX: Record<string, string> = {
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

export type MaterializedAttachment = {
  attachment_id: string;
  local_path: string;
  descriptor: AttachmentDescriptor;
};

export class AttachmentMaterializerError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly responseBody?: unknown;

  constructor(code: string, statusCode: number, message: string, cause?: unknown, responseBody?: unknown) {
    super(message);
    this.name = "AttachmentMaterializerError";
    this.code = code;
    this.statusCode = statusCode;
    this.cause = cause;
    this.responseBody = responseBody;
  }
}

export function createAttachmentMaterializer(options: {
  incomingDir: string;
  nodeId: string;
  orch: OrchProxyConfig;
  fetch: typeof globalThis.fetch;
}): {
  materialize(
    input: { sessionId: string; attachmentId: string; mode: "input" | "resolve"; deliveryId?: string },
    signal?: AbortSignal,
  ): Promise<MaterializedAttachment>;
} {
  const incomingRoot = path.resolve(options.incomingDir);
  const headers = { ...options.orch.headers, "x-soulstream-node-id": options.nodeId };

  return {
    async materialize(input, callerSignal) {
      assertPathId(input.sessionId);
      assertPathId(input.attachmentId);
      const timeout = AbortSignal.timeout(300_000);
      const signal = callerSignal ? AbortSignal.any([timeout, callerSignal]) : timeout;
      const query = new URLSearchParams({ session_id: input.sessionId, mode: input.mode });
      if (input.deliveryId !== undefined) query.set("delivery_id", input.deliveryId);

      try {
        const metadata = await fetchJson(
          options.fetch,
          workerUrl(options.orch.baseUrl, input.attachmentId, "metadata", query),
          headers,
          signal,
        );
        if (!metadata.ok) throw await responseError(metadata);
        const body = await metadata.json().catch(() => null) as { descriptor?: unknown; upload_status?: unknown } | null;
        const descriptor = validateDescriptor(body, input.attachmentId);
        const filename = cacheFilename(descriptor.name, descriptor.mime_type);
        const localPath = path.join(incomingRoot, input.sessionId, "assets", input.attachmentId, filename);
        if (!isPathUnderBase(incomingRoot, localPath)) {
          throw new Error("cache path escaped incoming root");
        }
        const cacheDir = path.dirname(localPath);
        await mkdir(cacheDir, { recursive: true });
        if (await hasVerifiedCache(localPath, descriptor)) {
          return { attachment_id: input.attachmentId, local_path: localPath, descriptor };
        }

        const content = await fetchJson(
          options.fetch,
          workerUrl(options.orch.baseUrl, input.attachmentId, "content", query),
          headers,
          signal,
        );
        if (!content.ok) throw await responseError(content);

        const tempPath = path.join(cacheDir, `.${input.attachmentId}.${randomUUID()}.tmp`);
        let installed = false;
        try {
          const hash = createHash("sha256");
          let byteCount = 0;
          const verifyStream = new Transform({
            transform(chunk: Buffer | Uint8Array, _encoding, callback) {
              const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              byteCount += bytes.byteLength;
              if (byteCount > descriptor.byte_size) {
                callback(new Error("attachment stream exceeded declared size"));
                return;
              }
              hash.update(bytes);
              callback(null, bytes);
            },
          });
          const source = content.body === null ? Readable.from([]) : Readable.fromWeb(content.body);
          await pipeline(source, verifyStream, createWriteStream(tempPath, { flags: "wx" }));
          if (byteCount !== descriptor.byte_size || hash.digest("hex") !== descriptor.checksum_sha256!.toLowerCase()) {
            throw new Error("attachment stream failed metadata verification");
          }
          await rename(tempPath, localPath);
          installed = true;
          return { attachment_id: input.attachmentId, local_path: localPath, descriptor };
        } finally {
          if (!installed) await rm(tempPath, { force: true }).catch(() => undefined);
        }
      } catch (error) {
        if (error instanceof AttachmentMaterializerError) throw error;
        throw new AttachmentMaterializerError(
          "ATTACHMENT_MATERIALIZATION_FAILED",
          500,
          "첨부 파일을 워커 캐시에 저장하지 못했습니다.",
          error,
        );
      }
    },
  };
}

function assertPathId(value: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new AttachmentMaterializerError("ATTACHMENT_INVALID_ID", 422, "첨부 ID가 올바르지 않습니다.");
  }
}

function workerUrl(baseUrl: string, id: string, resource: "metadata" | "content", query: URLSearchParams): string {
  const url = new URL(`/api/attachments/worker/${encodeURIComponent(id)}/${resource}`, baseUrl);
  url.search = query.toString();
  return url.toString();
}

function fetchJson(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<Response> {
  return fetchImpl(url, { method: "GET", headers, redirect: "error", signal });
}

async function responseError(response: Response): Promise<AttachmentMaterializerError> {
  const body: unknown = await response.json().catch(() => null);
  const record = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
  const code = typeof record.code === "string" ? record.code : "ATTACHMENT_MATERIALIZATION_FAILED";
  const message = typeof record.detail === "string" ? record.detail : `첨부 읽기에 실패했습니다 (HTTP ${response.status}).`;
  return new AttachmentMaterializerError(code, response.status, message, undefined, body);
}

function validateDescriptor(
  body: { descriptor?: unknown; upload_status?: unknown } | null,
  requestedId: string,
): AttachmentDescriptor {
  const value = body?.descriptor;
  if (body?.upload_status !== "committed" || value === null || typeof value !== "object") return invalidMetadata();
  const descriptor = value as Partial<AttachmentDescriptor>;
  if (
    descriptor.attachment_id !== requestedId ||
    typeof descriptor.name !== "string" ||
    typeof descriptor.mime_type !== "string" ||
    !Number.isSafeInteger(descriptor.byte_size) ||
    descriptor.byte_size! < 0 ||
    descriptor.byte_size! > MAX_ATTACHMENT_BYTES ||
    typeof descriptor.checksum_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/i.test(descriptor.checksum_sha256)
  ) return invalidMetadata();
  return value as AttachmentDescriptor;
}

function invalidMetadata(): never {
  throw new AttachmentMaterializerError("ATTACHMENT_INVALID_METADATA", 500, "중앙 첨부 정보가 올바르지 않습니다.");
}

function cacheFilename(name: string, mimeType: string): string {
  const filename = sanitizeOriginalFilename(name).replace(/#/g, "_");
  const normalizedMime = mimeType.trim().toLowerCase().split(";", 1)[0] ?? "";
  const suffix = IMAGE_SUFFIX[normalizedMime];
  const filenameType = getImageAttachmentMediaType(filename);
  if (suffix !== undefined) return filenameType === normalizedMime ? filename : `${filename}${suffix}`;
  return filenameType === undefined ? filename : `${filename}.data`;
}

async function hasVerifiedCache(filePath: string, descriptor: AttachmentDescriptor): Promise<boolean> {
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.size !== descriptor.byte_size) return false;
    const hash = createHash("sha256");
    let byteCount = 0;
    for await (const chunk of createReadStream(filePath)) {
      byteCount += chunk.byteLength;
      hash.update(chunk);
    }
    return byteCount === descriptor.byte_size && hash.digest("hex") === descriptor.checksum_sha256!.toLowerCase();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
