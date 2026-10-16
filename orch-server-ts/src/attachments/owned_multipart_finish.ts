import type { FastifyReply, FastifyRequest } from "fastify";

import type { LiveBoardAssetCompletedPart } from "../runtime/live_board_asset_storage.js";
import type {
  AttachmentStorageBinding,
  OwnedAttachmentUpload,
  VerifiedAttachmentUploadTicket,
} from "./attachment_commit_contract.js";
import { bindAttachmentReadAbortSignal } from "./attachment_read_routes.js";
import { AttachmentTransportConnectionError } from "./attachment_routes.js";
import { finishLegacyUpload } from "./attachment_upload_legacy.js";
import {
  AttachmentUploadHttpError,
  UPLOAD_CONTRACT_HEADER,
  UPLOAD_CONTRACT_ID_V1,
  readUploadMode,
  sendUploadFailure,
  type UploadMode,
  type UserUploadActor,
} from "./attachment_upload_http.js";
import {
  ATTACHMENT_TICKET_SECONDS,
  LARGE_ATTACHMENT_PART_SIZE,
  verifyAttachmentTicket,
  type AttachmentUploadTicket,
} from "./attachment_upload_ticket.js";
import type { MultipartAttachmentOptions } from "./multipart_attachment_routes.js";

export type OwnedMultipartFinishOptions = MultipartAttachmentOptions & {
  readonly uploads: NonNullable<MultipartAttachmentOptions["uploads"]>;
};

type ParseParts = (value: unknown, count: number) => readonly LiveBoardAssetCompletedPart[];

// Owned multipart complete. The committed object becomes the canonical original;
// the legacy contract then warms the worker cache once and stores one alias,
// while the id-v1 contract answers with the owner descriptor.
export async function ownedMultipartComplete(
  request: FastifyRequest,
  reply: FastifyReply,
  options: OwnedMultipartFinishOptions,
  parseParts: ParseParts,
): Promise<FastifyReply> {
  const { abort, cleanup } = bindAttachmentReadAbortSignal(request, reply);
  let committedId: string | undefined;
  try {
    const verified = await verifyOwnedRequest(request, request.body, options);
    const { ticket, binding, actor, mode } = verified;
    assertOriginalTicket(ticket);
    const owner = { kind: "user_email" as const, key: actor.email };
    const row = await requireOwnedRow(options, ticket, owner);
    assertRowMatches(row, ticket, binding);
    if (row.uploadStatus === "pending" && row.multipartUploadId !== ticket.uploadId) {
      throw conflict("업로드 세션이 서버 기록과 다릅니다");
    }
    const internalTicket = toInternalTicket(ticket, row);
    const parts = readParts(parseParts, requestBody(request).parts, Math.ceil(ticket.size / LARGE_ATTACHMENT_PART_SIZE));
    abort.signal.throwIfAborted();
    const committed = await options.uploads.commits.completeMultipart({ owner, ticket: internalTicket, parts, signal: abort.signal });
    committedId = committed.attachmentId;
    if (mode === "id-v1") {
      const metadata = await options.uploads.ownerMetadata(actor, committed.attachmentId, { type: "owner" });
      reply.header(UPLOAD_CONTRACT_HEADER, UPLOAD_CONTRACT_ID_V1);
      return reply.code(201).send({ attachment: metadata.descriptor });
    }
    const nodeId = ticket.nodeId as string;
    const result = await finishLegacyUpload({
      committed,
      nodeId,
      repository: options.uploads.repository,
      cache: async () => {
        const node = await options.getNode(nodeId);
        if (!node) throw new AttachmentTransportConnectionError("첨부 대상 노드가 연결되지 않았습니다");
        if (node.capabilities?.attachment_import_v1 !== true) {
          throw new AttachmentUploadHttpError(409, "cache_unsupported", "첨부 대상 워커가 대용량 첨부를 지원하지 않습니다. 워커 업데이트가 필요합니다");
        }
        const downloadUrl = await binding.storage.createPresignedGetUrl({ storageKey: committed.storageKey, expiresSeconds: ATTACHMENT_TICKET_SECONDS });
        return options.importAttachment(nodeId, {
          downloadUrl, expectedSize: committed.byteSize, sessionId: ticket.sessionId,
          filename: committed.originalName, contentType: committed.mimeType, uploadId: committed.attachmentId,
        }, abort.signal);
      },
    });
    return reply.code(201).send(result);
  } catch (error) {
    return sendUploadFailure(reply, error, committedId);
  } finally {
    cleanup();
  }
}

// Owned multipart abort. The original R2 object is never permanently deleted; a
// committed upload stays committed and only reports that it could not be aborted.
export async function ownedMultipartAbort(
  request: FastifyRequest,
  reply: FastifyReply,
  options: OwnedMultipartFinishOptions,
): Promise<FastifyReply> {
  try {
    const { ticket, binding, actor, mode } = await verifyOwnedRequest(request, request.body, options);
    if (isPreContractTransfer(ticket)) {
      await binding.storage.abortMultipartUpload({ storageKey: ticket.storageKey, uploadId: ticket.uploadId }).catch(() => undefined);
      return reply.send({ aborted: true });
    }
    const owner = { kind: "user_email" as const, key: actor.email };
    const row = await requireOwnedRow(options, ticket, owner);
    assertRowMatches(row, ticket, binding);
    if (row.uploadStatus === "committed") return reply.send({ aborted: false, committed: true });
    if (row.multipartUploadId !== ticket.uploadId) throw conflict("업로드 세션이 서버 기록과 다릅니다");
    await options.uploads.commits.abortMultipart({ owner, ticket: toInternalTicket(ticket, row) });
    const after = await options.uploads.repository.getOwnedUpload(ticket.importId, owner);
    const committed = after?.uploadStatus === "committed";
    if (!committed && mode === "legacy" && ticket.nodeId !== null) {
      await options.abortImport(ticket.nodeId, ticket.importId).catch(() => undefined);
    }
    return reply.send({ aborted: !committed, committed });
  } catch (error) {
    return sendUploadFailure(reply, error);
  }
}

// Shared finish-path verification. Both complete and abort must agree on the
// caller, the contract and the storage settings before any commit or abort.
async function verifyOwnedRequest(
  request: FastifyRequest,
  body: unknown,
  options: OwnedMultipartFinishOptions,
): Promise<{ ticket: AttachmentUploadTicket; binding: AttachmentStorageBinding; actor: UserUploadActor; mode: UploadMode }> {
  const record = asObject(body);
  const raw = record.ticket;
  const token = typeof raw === "string" && raw.trim().length > 0 ? raw : null;
  const ticket = token === null ? null : verifyAttachmentTicket(token, await options.resolveSecret());
  if (!ticket) throw new AttachmentUploadHttpError(403, "invalid_upload_ticket", "첨부 업로드 ticket이 만료되었거나 올바르지 않습니다");
  const actor = await options.uploads.resolveActor(request);
  if (actor === null) throw new AttachmentUploadHttpError(401, "unauthenticated", "로그인이 필요합니다");
  if (normalizeEmail(ticket.sub) !== normalizeEmail(actor.email)) throw new AttachmentUploadHttpError(403, "invalid_upload_ticket", "첨부 업로드 ticket의 사용자가 다릅니다");
  const mode = readUploadMode(request, ticket.responseContract ?? "legacy");
  const provided = (request.query as Record<string, unknown>).nodeId;
  if (provided !== undefined && provided !== ticket.nodeId) {
    throw new AttachmentUploadHttpError(403, "invalid_upload_ticket", "첨부 업로드 ticket의 노드가 다릅니다");
  }
  if (mode === "legacy" && typeof ticket.nodeId !== "string") {
    throw new AttachmentUploadHttpError(403, "invalid_upload_ticket", "첨부 업로드 ticket의 노드가 없습니다");
  }
  await options.uploads.requireRegistration(request, {
    actor,
    sessionId: ticket.sessionId,
    folderId: ticket.folderId,
    mode,
    small: false,
  });
  const binding = await options.uploads.resolveBinding();
  if (!binding) throw new AttachmentUploadHttpError(503, "storage_unavailable", "대용량 첨부용 R2 설정이 필요합니다");
  if (binding.identity !== ticket.settingsIdentity) {
    throw conflict("첨부 저장소 설정이 변경되었습니다. 다시 업로드해 주세요");
  }
  return { ticket, binding, actor, mode };
}

function assertOriginalTicket(ticket: AttachmentUploadTicket): void {
  if (isPreContractTransfer(ticket)) {
    throw new AttachmentUploadHttpError(409, "upload_restart_required", "업로드를 다시 시작해 주세요");
  }
}

// A pre-contract transfer ticket predates the commit service and cannot be
// completed against it; it is only meaningful to the worker cache path.
function isPreContractTransfer(ticket: AttachmentUploadTicket): boolean {
  return ticket.responseContract === undefined
    && ticket.storageKey === `session-attachments/transfers/${ticket.importId}`;
}

async function requireOwnedRow(
  options: OwnedMultipartFinishOptions,
  ticket: AttachmentUploadTicket,
  owner: { kind: "user_email"; key: string },
): Promise<OwnedAttachmentUpload> {
  const row = await options.uploads.repository.getOwnedUpload(ticket.importId, owner);
  if (!row || row.garbageCollectedAt !== null) throw conflict("업로드 기록을 찾을 수 없습니다");
  return row;
}

function assertRowMatches(row: OwnedAttachmentUpload, ticket: AttachmentUploadTicket, binding: AttachmentStorageBinding): void {
  const mismatch = row.attachmentId !== ticket.importId
    || row.storageKey !== ticket.storageKey
    || row.originalName !== ticket.filename
    || row.mimeType !== ticket.contentType
    || row.byteSize !== ticket.size
    || row.registration.sourceSessionId !== ticket.sessionId
    || row.storageEndpoint !== binding.location.endpoint
    || row.storageBucket !== binding.location.bucket;
  if (mismatch) throw conflict("업로드 정보가 서버 기록과 다릅니다");
}

// The commit service verifies against its own ticket shape: provenance comes from
// the stored registration, never from the client token.
function toInternalTicket(ticket: AttachmentUploadTicket, row: OwnedAttachmentUpload): VerifiedAttachmentUploadTicket {
  return {
    importId: ticket.importId,
    storageKey: ticket.storageKey,
    uploadId: ticket.uploadId,
    filename: ticket.filename,
    size: ticket.size,
    contentType: ticket.contentType,
    sourceSessionId: row.registration.sourceSessionId,
    sourceNodeId: row.registration.sourceNodeId,
    settingsIdentity: ticket.settingsIdentity,
    exp: ticket.exp,
    ...(ticket.checksumSha256 === undefined ? {} : { checksumSha256: ticket.checksumSha256 }),
  };
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

// The route's own part validator throws a plain 400 error without a code, which
// the shared failure mapper would mask as 502; surface it as an input error.
function readParts(parseParts: ParseParts, value: unknown, count: number): readonly LiveBoardAssetCompletedPart[] {
  try {
    return parseParts(value, count);
  } catch (error) {
    throw new AttachmentUploadHttpError(400, "invalid_upload", error instanceof Error ? error.message : "업로드 part가 올바르지 않습니다");
  }
}

function conflict(detail: string): AttachmentUploadHttpError {
  return new AttachmentUploadHttpError(409, "upload_conflict", detail);
}

function requestBody(request: FastifyRequest): Record<string, unknown> {
  return asObject(request.body);
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AttachmentUploadHttpError(400, "invalid_upload", "JSON 객체가 필요합니다");
  }
  return value as Record<string, unknown>;
}
