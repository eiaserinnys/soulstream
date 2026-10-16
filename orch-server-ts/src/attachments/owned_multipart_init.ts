import type { FastifyReply, FastifyRequest } from "fastify";

import {
  LARGE_ATTACHMENT_MAX_SIZE,
  issueAttachmentTicket,
} from "./attachment_upload_ticket.js";
import {
  AttachmentUploadHttpError,
  UPLOAD_CONTRACT_HEADER,
  UPLOAD_CONTRACT_ID_V1,
  readUploadChecksum,
  readUploadId,
  readUploadMode,
  sendUploadFailure,
  type UploadMode,
} from "./attachment_upload_http.js";
import type { MultipartAttachmentOptions } from "./multipart_attachment_routes.js";

export type OwnedMultipartOptions = MultipartAttachmentOptions & {
  readonly uploads: NonNullable<MultipartAttachmentOptions["uploads"]>;
};

// Owned multipart init. The object is registered (and its pending row created)
// through the commit service before any node is contacted; the node is only a
// later cache target for the legacy contract. The ticket the client receives is
// re-signed from the service's own ticket so its expiry is never extended.
export async function ownedMultipartInit(
  request: FastifyRequest,
  reply: FastifyReply,
  options: OwnedMultipartOptions,
): Promise<FastifyReply> {
  try {
    const mode = readUploadMode(request);
    const actor = await options.uploads.resolveActor(request);
    if (actor === null) {
      throw new AttachmentUploadHttpError(401, "unauthenticated", "로그인이 필요합니다");
    }
    const body = object(request.body);
    const sessionId = text(body.session_id, "session_id");
    const filename = text(body.filename, "filename");
    const contentType = text(body.content_type, "content_type");
    const size = body.size;
    if (size === 0) {
      throw new AttachmentUploadHttpError(400, "invalid_upload", "0바이트 파일은 작은 업로드(POST /api/attachments/sessions)를 사용해 주세요");
    }
    if (!Number.isSafeInteger(size) || (size as number) < 0 || (size as number) > LARGE_ATTACHMENT_MAX_SIZE) {
      throw new AttachmentUploadHttpError(400, "invalid_upload", "파일 크기는 0보다 크고 5GiB 이하여야 합니다");
    }
    const folderId = body.folder_id == null ? null : text(body.folder_id, "folder_id");
    const attachmentId = readUploadId(body.upload_id);
    const checksumSha256 = readUploadChecksum(body.checksum_sha256);
    const nodeId = readInitNodeId(request, mode);

    const registration = await options.uploads.requireRegistration(request, {
      actor,
      sessionId,
      folderId,
      mode,
      small: false,
    });
    const init = await options.uploads.commits.initMultipart({
      spec: {
        attachmentId,
        owner: { kind: "user_email", key: actor.email },
        registration,
        originalName: filename,
        mimeType: contentType,
        byteSize: size as number,
        ...(checksumSha256 === undefined ? {} : { checksumSha256 }),
      },
    });

    const ticket = issueAttachmentTicket({
      purpose: "session_attachment_upload",
      sub: actor.email,
      sessionId,
      folderId,
      nodeId,
      storageKey: init.ticket.storageKey,
      uploadId: init.ticket.uploadId,
      importId: init.ticket.importId,
      filename: init.ticket.filename,
      size: init.ticket.size,
      contentType: init.ticket.contentType,
      settingsIdentity: init.ticket.settingsIdentity,
      exp: init.ticket.exp,
      responseContract: mode,
      ...(init.ticket.checksumSha256 === undefined ? {} : { checksumSha256: init.ticket.checksumSha256 }),
    }, await options.resolveSecret());

    const payload = {
      ticket,
      partSize: init.partSize,
      parts: init.parts,
      ...(mode === "id-v1" ? { attachment_id: init.ticket.importId } : {}),
    };
    if (mode === "id-v1") reply.header(UPLOAD_CONTRACT_HEADER, UPLOAD_CONTRACT_ID_V1);
    return reply.code(201).send(payload);
  } catch (error) {
    return sendUploadFailure(reply, error);
  }
}

// A legacy ticket resolves its object through a node cache, so the target node
// must be named up front. id-v1 tickets may omit it and default to no cache.
function readInitNodeId(request: FastifyRequest, mode: UploadMode): string | null {
  const query = request.query;
  const raw = typeof query === "object" && query !== null && !Array.isArray(query)
    ? (query as Record<string, unknown>).nodeId
    : undefined;
  if (raw === undefined) {
    if (mode === "legacy") {
      throw new AttachmentUploadHttpError(400, "invalid_upload", "nodeId가 필요합니다");
    }
    return null;
  }
  if (typeof raw !== "string" || raw === "") {
    throw new AttachmentUploadHttpError(400, "invalid_upload", "nodeId 형식이 올바르지 않습니다");
  }
  return raw;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AttachmentUploadHttpError(400, "invalid_upload", "JSON 객체가 필요합니다");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AttachmentUploadHttpError(400, "invalid_upload", `${name}이 필요합니다`);
  }
  return value;
}
