import path from "node:path";

import type {
  AttachmentDescriptor,
  AttachmentReadContext,
  AttachmentScope,
} from "@soulstream/wire-schema/attachments";
import {
  normalizedMimeType,
  parseContentLength,
  parseSingleRange,
  previewInfo,
  responseHeaders,
  safeHeader,
} from "./attachment_read_http.js";

export type AttachmentReadActor =
  | { readonly kind: "user"; readonly email: string }
  | {
    readonly kind: "agent";
    readonly trustedCallerSessionId: string;
    readonly ownerEmail: string;
  };

export type AttachmentAssetRow = {
  readonly id: string;
  readonly storageKey: string;
  readonly storagePurpose: string;
  readonly storageEndpoint: string | null;
  readonly storageBucket: string | null;
  readonly ownerKind: string | null;
  readonly ownerKey: string | null;
  readonly registrationScope: unknown;
  readonly sourceSessionId: string | null;
  readonly originalName: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly checksumSha256: string | null;
  readonly uploadStatus: "pending" | "committed";
};

export type AttachmentLegacyAliasRow = {
  readonly assetId: string | null;
  readonly availability: "resolved" | "missing";
};

export type AttachmentScopeEvidence = {
  readonly scope: AttachmentScope;
  readonly folderId: string | null;
  readonly hasStoredRef: boolean;
};

export type AttachmentReadRepository = {
  readonly getAsset: (id: string) => Promise<AttachmentAssetRow | null>;
  readonly getLegacyAlias: (
    nodeId: string,
    normalizedPath: string,
  ) => Promise<AttachmentLegacyAliasRow | null>;
  readonly getSqlScopeEvidence: (
    scope: Exclude<AttachmentScope, { type: "page" }>,
    attachmentId: string,
  ) => Promise<AttachmentScopeEvidence | null>;
  readonly listLegacyCandidateScopes: (
    asset: AttachmentAssetRow,
  ) => Promise<readonly AttachmentScope[]>;
};

export type AttachmentReadObjectStorage = {
  readonly openObject: (input: {
    readonly storageKey: string;
    readonly method?: "GET" | "HEAD";
    readonly range?: string;
    readonly signal?: AbortSignal;
  }) => Promise<Response>;
};

export type AttachmentReadStorageBinding = {
  readonly storage: AttachmentReadObjectStorage;
  readonly identity: string;
  readonly location: { readonly endpoint: string; readonly bucket: string };
};

export type AttachmentReadAccess = {
  readonly requireScope: (
    actor: AttachmentReadActor,
    scope: AttachmentScope,
    evidence: AttachmentScopeEvidence,
  ) => Promise<void>;
};

export type ReadPageAttachmentEvidence = (
  pageId: string,
  attachmentId: string,
) => Promise<AttachmentScopeEvidence | null>;

export type AttachmentMetadataResponse = {
  readonly descriptor: AttachmentDescriptor;
  readonly upload_status: "pending" | "committed";
};

export type AttachmentReadService = {
  readonly metadata: (
    actor: AttachmentReadActor,
    id: string,
    context: AttachmentReadContext,
  ) => Promise<AttachmentMetadataResponse>;
  readonly content: (
    actor: AttachmentReadActor,
    id: string,
    context: AttachmentReadContext,
    input: {
      readonly method: "GET" | "HEAD";
      readonly range?: string;
      readonly signal?: AbortSignal;
      readonly download?: boolean;
    },
  ) => Promise<Response>;
  readonly legacy: (
    resolveActor: () => Promise<AttachmentReadActor>,
    nodeId: string,
    normalizedPath: string,
    context: AttachmentReadContext | undefined,
    input: {
      readonly method: "GET" | "HEAD";
      readonly range?: string;
      readonly signal?: AbortSignal;
      readonly download?: boolean;
    },
  ) => Promise<{ readonly kind: "unresolved" } | { readonly kind: "response"; readonly response: Response }>;
};

export class AttachmentReadError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly headers?: Readonly<Record<string, string>>;

  constructor(
    code: string,
    message: string,
    statusCode: number,
    headers?: Readonly<Record<string, string>>,
  ) {
    super(message);
    this.name = "AttachmentReadError";
    this.code = code;
    this.statusCode = statusCode;
    this.headers = headers;
  }
}

export type CreateAttachmentReadServiceOptions = {
  readonly repository: AttachmentReadRepository;
  readonly access: AttachmentReadAccess;
  readonly resolveReadStorage: () => Promise<AttachmentReadStorageBinding | null>;
  readonly readPageAttachmentEvidence: ReadPageAttachmentEvidence;
};

export function createAttachmentReadService(
  options: CreateAttachmentReadServiceOptions,
): AttachmentReadService {
  return {
    async metadata(actor, id, context) {
      const asset = await getReadableAttachment(options.repository, id);
      await authorize(options, actor, asset, context);
      if (asset.uploadStatus === "pending" && context.type !== "owner") {
        throw notCommittedError();
      }
      return projectMetadata(asset);
    },
    async content(actor, id, context, input) {
      const asset = await getReadableAttachment(options.repository, id);
      await authorize(options, actor, asset, context);
      if (asset.uploadStatus !== "committed") throw notCommittedError();

      const range = input.method === "GET" && input.range !== undefined
        ? parseSingleRange(input.range, asset.byteSize)
        : undefined;
      if (range === null) throw rangeError(asset.byteSize);
      const binding = await readBinding(options.resolveReadStorage);
      if (
        asset.storageEndpoint === null || asset.storageBucket === null ||
        asset.storageEndpoint !== binding.location.endpoint ||
        asset.storageBucket !== binding.location.bucket
      ) {
        throw new AttachmentReadError(
          "ATTACHMENT_STORAGE_UNAVAILABLE",
          "Attachment storage is unavailable",
          503,
        );
      }

      let upstream: Response;
      try {
        upstream = await binding.storage.openObject({
          storageKey: asset.storageKey,
          method: input.method,
          ...(range === undefined ? {} : { range: range.header }),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
      } catch {
        throw storageReadError();
      }

      if (upstream.status === 404) {
        await cancelBody(upstream);
        throw new AttachmentReadError(
          "ATTACHMENT_OBJECT_NOT_FOUND",
          "Attachment object not found",
          404,
        );
      }
      if (input.method === "HEAD") {
        if (upstream.status !== 200) {
          await cancelBody(upstream);
          throw storageReadError();
        }
        await cancelBody(upstream);
        return new Response(null, {
          status: 200,
          headers: responseHeaders(asset, input.download === true, {
            contentLength: asset.byteSize,
            etag: safeHeader(upstream.headers.get("etag")),
            lastModified: safeHeader(upstream.headers.get("last-modified")),
          }),
        });
      }

      if (range !== undefined) {
        const expectedContentRange = `bytes ${range.start}-${range.end}/${asset.byteSize}`;
        const actualContentRange = upstream.headers.get("content-range");
        const upstreamLength = parseContentLength(upstream.headers.get("content-length"));
        if (
          upstream.status !== 206 || actualContentRange !== expectedContentRange ||
          upstreamLength !== range.length ||
          upstream.body === null
        ) {
          await cancelBody(upstream);
          throw storageReadError();
        }
        return new Response(upstream.body, {
          status: 206,
          headers: responseHeaders(asset, input.download === true, {
            contentLength: range.length,
            contentRange: expectedContentRange,
            etag: safeHeader(upstream.headers.get("etag")),
            lastModified: safeHeader(upstream.headers.get("last-modified")),
          }),
        });
      }

      const upstreamLength = parseContentLength(upstream.headers.get("content-length"));
      if (
        upstream.status !== 200 ||
        (upstreamLength !== null && upstreamLength !== asset.byteSize) ||
        (asset.byteSize > 0 && upstream.body === null)
      ) {
        await cancelBody(upstream);
        throw storageReadError();
      }
      return new Response(upstream.body, {
        status: 200,
        headers: responseHeaders(asset, input.download === true, {
          contentLength: asset.byteSize,
          etag: safeHeader(upstream.headers.get("etag")),
          lastModified: safeHeader(upstream.headers.get("last-modified")),
        }),
      });
    },
    async legacy(resolveActor, nodeId, normalizedPath, context, input) {
      const alias = await options.repository.getLegacyAlias(nodeId, normalizedPath);
      if (alias === null) return { kind: "unresolved" };
      const actor = await resolveActor();
      if (alias.availability === "missing" || alias.assetId === null) {
        throw new AttachmentReadError(
          "ATTACHMENT_SOURCE_MISSING",
          "Attachment source is missing",
          404,
        );
      }
      const resolvedContext = context ?? { type: "owner" as const };
      const asset = await getReadableAttachment(options.repository, alias.assetId);
      const allowedContext = context === undefined
        ? await authorizeWithoutContext(options, actor, asset)
        : resolvedContext;
      if (asset.uploadStatus !== "committed") throw notCommittedError();
      return {
        kind: "response",
        response: await this.content(actor, alias.assetId, allowedContext, input),
      };
    },
  };
}

export function normalizeAttachmentLegacyPath(value: string): string {
  return path.posix.normalize(value.replace(/\\/g, "/"));
}

export function attachmentReadContext(
  type: string | undefined,
  id: string | undefined,
): AttachmentReadContext {
  if (type === undefined && id === undefined) return { type: "owner" };
  if (type === "owner" && id === undefined) return { type: "owner" };
  if (id === undefined || id.length === 0) throw invalidContextError();
  if (type === "session" || type === "card" || type === "page" || type === "board_item") {
    return { type, id };
  }
  throw invalidContextError();
}

export function attachmentReadContextFromOptionalQuery(
  type: string | undefined,
  id: string | undefined,
): AttachmentReadContext | undefined {
  if (type === undefined && id === undefined) return undefined;
  return attachmentReadContext(type, id);
}

async function getReadableAttachment(
  repository: AttachmentReadRepository,
  id: string,
): Promise<AttachmentAssetRow> {
  const asset = await repository.getAsset(id);
  if (asset === null || asset.storagePurpose !== "attachment") {
    throw new AttachmentReadError("ATTACHMENT_NOT_FOUND", "Attachment not found", 404);
  }
  if (!Number.isSafeInteger(asset.byteSize) || asset.byteSize < 0) {
    throw new AttachmentReadError("ATTACHMENT_INVALID_METADATA", "Attachment metadata is invalid", 500);
  }
  return asset;
}

async function authorize(
  options: CreateAttachmentReadServiceOptions,
  actor: AttachmentReadActor,
  asset: AttachmentAssetRow,
  context: AttachmentReadContext,
): Promise<void> {
  if (context.type === "owner") {
    if (!isOwner(actor, asset)) throw accessDeniedError();
    return;
  }
  const evidence = await scopeEvidence(options, context, asset.id);
  if (evidence === null) throw new AttachmentReadError("ATTACHMENT_SCOPE_NOT_FOUND", "Attachment scope not found", 404);
  await options.access.requireScope(actor, context, evidence);
  if (!evidence.hasStoredRef) throw accessDeniedError();
}

async function authorizeWithoutContext(
  options: CreateAttachmentReadServiceOptions,
  actor: AttachmentReadActor,
  asset: AttachmentAssetRow,
): Promise<AttachmentReadContext> {
  if (isOwner(actor, asset)) return { type: "owner" };
  for (const scope of await options.repository.listLegacyCandidateScopes(asset)) {
    const evidence = await scopeEvidence(options, scope, asset.id);
    if (evidence === null || !evidence.hasStoredRef) continue;
    try {
      await options.access.requireScope(actor, scope, evidence);
      return scope;
    } catch (error) {
      if (statusCode(error) !== 403) throw error;
    }
  }
  throw accessDeniedError();
}

async function scopeEvidence(
  options: CreateAttachmentReadServiceOptions,
  scope: AttachmentScope,
  attachmentId: string,
): Promise<AttachmentScopeEvidence | null> {
  if (scope.type === "page") {
    try {
      return await options.readPageAttachmentEvidence(scope.id, attachmentId);
    } catch (error) {
      if (error instanceof Error && error.message === `page not found: ${scope.id}`) return null;
      throw new AttachmentReadError("ATTACHMENT_SCOPE_UNAVAILABLE", "Attachment scope is unavailable", 503);
    }
  }
  return await options.repository.getSqlScopeEvidence(scope, attachmentId);
}

function isOwner(actor: AttachmentReadActor, asset: AttachmentAssetRow): boolean {
  if (actor.kind === "user") {
    return asset.ownerKind === "user_email" && asset.ownerKey !== null &&
      normalizeEmail(asset.ownerKey) === normalizeEmail(actor.email);
  }
  return asset.ownerKind === "agent_session" &&
    asset.ownerKey === actor.trustedCallerSessionId &&
    actor.trustedCallerSessionId.trim().length > 0 &&
    normalizeEmail(actor.ownerEmail).length > 0;
}

function projectMetadata(asset: AttachmentAssetRow): AttachmentMetadataResponse {
  const mimeType = normalizedMimeType(asset.mimeType);
  const preview = previewInfo(mimeType);
  return {
    descriptor: {
      attachment_id: asset.id,
      name: asset.originalName,
      mime_type: asset.mimeType,
      byte_size: asset.byteSize,
      checksum_sha256: asset.checksumSha256,
      width: asset.width,
      height: asset.height,
      preview_kind: preview.kind,
      preview_mime_type: preview.mimeType,
    },
    upload_status: asset.uploadStatus,
  };
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

async function readBinding(
  resolve: CreateAttachmentReadServiceOptions["resolveReadStorage"],
): Promise<AttachmentReadStorageBinding> {
  try {
    const binding = await resolve();
    if (
      binding !== null && binding.location.endpoint.length > 0 &&
      binding.location.bucket.length > 0
    ) return binding;
  } catch {
    // Settings failures are intentionally reduced to a non-sensitive status.
  }
  throw new AttachmentReadError(
    "ATTACHMENT_STORAGE_UNAVAILABLE",
    "Attachment storage is unavailable",
    503,
  );
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation after HEAD or an invalid upstream response is best effort.
  }
}

function accessDeniedError(): AttachmentReadError {
  return new AttachmentReadError("ATTACHMENT_ACCESS_DENIED", "Attachment access denied", 403);
}

function invalidContextError(): AttachmentReadError {
  return new AttachmentReadError("ATTACHMENT_INVALID_CONTEXT", "Invalid attachment context", 400);
}

function notCommittedError(): AttachmentReadError {
  return new AttachmentReadError("ATTACHMENT_NOT_COMMITTED", "Attachment upload is not committed", 409);
}

function rangeError(size: number): AttachmentReadError {
  return new AttachmentReadError(
    "ATTACHMENT_RANGE_NOT_SATISFIABLE",
    "Requested range is not satisfiable",
    416,
    { "Content-Range": `bytes */${size}` },
  );
}

function storageReadError(): AttachmentReadError {
  return new AttachmentReadError(
    "ATTACHMENT_STORAGE_READ_FAILED",
    "Attachment storage read failed",
    502,
  );
}

function statusCode(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "statusCode" in error &&
    typeof error.statusCode === "number" ? error.statusCode : undefined;
}

export function attachmentScopeFromRegistrationScope(value: unknown): AttachmentScope | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    (record.type === "session" || record.type === "card" || record.type === "page" || record.type === "board_item") &&
    typeof record.id === "string" && record.id.length > 0
  ) return { type: record.type, id: record.id };
  return null;
}
