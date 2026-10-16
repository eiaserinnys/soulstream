import type {
  AttachmentCommitRepository,
  CommitResult,
} from "./attachment_commit_contract.js";
import { normalizeAttachmentLegacyPath } from "./attachment_read_service.js";
import {
  AttachmentTransportConnectionError,
  AttachmentTransportTimeoutError,
} from "./attachment_routes.js";
import type { LegacyUploadResult } from "./attachment_upload_http.js";
import { AttachmentUploadHttpError } from "./attachment_upload_http.js";

export type FinishLegacyUploadInput = {
  readonly committed: CommitResult;
  readonly nodeId: string;
  readonly repository: AttachmentCommitRepository;
  readonly cache: () => Promise<unknown>;
};

// Finishes a committed legacy upload: reuse a stored alias when the same asset
// was already resolved for this node, otherwise warm the worker cache once and
// persist one alias. The cache result is never returned until its alias lands,
// and a failed cache never deletes the committed R2 object.
export async function finishLegacyUpload(
  input: FinishLegacyUploadInput,
): Promise<LegacyUploadResult> {
  const stored = await input.repository.findLegacyAliasForUpload(
    input.committed.attachmentId,
    input.nodeId,
  );
  if (stored !== null) {
    return {
      path: stored.originalPath,
      filename: lastPathSegment(stored.originalPath),
      size: input.committed.byteSize,
      content_type: input.committed.mimeType,
    };
  }

  const worker = readWorkerResult(await runCache(input.cache), input.committed.byteSize);
  const alias = await input.repository.insertLegacyAlias({
    nodeId: input.nodeId,
    normalizedPath: normalizeAttachmentLegacyPath(worker.path),
    assetId: input.committed.attachmentId,
    originalPath: worker.path,
  });
  if (alias === null) {
    throw new AttachmentUploadHttpError(409, "alias_conflict", "첨부 경로 별칭이 이미 사용 중입니다");
  }
  return worker;
}

async function runCache(cache: () => Promise<unknown>): Promise<unknown> {
  try {
    return await cache();
  } catch (error) {
    throw mapCacheError(error);
  }
}

// Only the transport exception types keep their meaning; every other failure is
// masked so a raw download URL, ticket or credential never reaches the detail.
function mapCacheError(error: unknown): AttachmentUploadHttpError {
  if (error instanceof AttachmentTransportConnectionError) {
    return new AttachmentUploadHttpError(503, "cache_unavailable", "첨부 노드를 일시적으로 사용할 수 없습니다");
  }
  if (error instanceof AttachmentTransportTimeoutError) {
    return new AttachmentUploadHttpError(504, "cache_timeout", "첨부 캐시 응답이 지연되었습니다");
  }
  if (isStatusError(error, 409)) {
    return new AttachmentUploadHttpError(409, "cache_unsupported", "노드가 첨부 캐시를 지원하지 않습니다");
  }
  return new AttachmentUploadHttpError(502, "cache_failed", "첨부 캐시에 실패했습니다");
}

function readWorkerResult(value: unknown, expectedSize: number): LegacyUploadResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw cacheFailed();
  const record = value as Record<string, unknown>;
  const path = nonEmptyString(record.path);
  const filename = nonEmptyString(record.filename);
  const contentType = nonEmptyString(record.content_type);
  const size = record.size;
  if (
    path === null ||
    filename === null ||
    contentType === null ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size !== expectedSize
  ) {
    throw cacheFailed();
  }
  return { path, filename, size, content_type: contentType };
}

function cacheFailed(): AttachmentUploadHttpError {
  return new AttachmentUploadHttpError(502, "cache_failed", "첨부 캐시 결과가 올바르지 않습니다");
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function lastPathSegment(value: string): string {
  const segments = value.replace(/\\/g, "/").split("/").filter((segment) => segment.length > 0);
  return segments.length > 0 ? segments[segments.length - 1]! : value;
}

function isStatusError(error: unknown, statusCode: number): boolean {
  return typeof error === "object"
    && error !== null
    && (error as { statusCode?: unknown }).statusCode === statusCode;
}
