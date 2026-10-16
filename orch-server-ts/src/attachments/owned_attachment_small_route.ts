import type { FastifyReply, FastifyRequest } from "fastify";

import type { MultipartFile, MultipartForm } from "../http/multipart_form.js";
import type {
  CommitResult,
  UploadRegistration,
  UploadSpec,
} from "./attachment_commit_contract.js";
import { bindAttachmentReadAbortSignal } from "./attachment_read_routes.js";
import {
  AttachmentUploadHttpError,
  UPLOAD_CONTRACT_HEADER,
  UPLOAD_CONTRACT_ID_V1,
  readUploadChecksum,
  readUploadId,
  sendUploadFailure,
  type AttachmentUploadOptions,
  type UploadMode,
} from "./attachment_upload_http.js";
import { finishLegacyUpload } from "./attachment_upload_legacy.js";

export type OwnedSmallUploadInput = {
  readonly uploads: AttachmentUploadOptions;
  readonly form: MultipartForm;
  readonly mode: UploadMode;
  readonly cache: (nodeId: string, sessionId: string, file: MultipartFile) => Promise<unknown>;
};

// Owned small upload branch of POST /api/attachments/sessions. A verified user
// commits to R2 before the node is ever consulted; the worker cache and alias
// are only warmed when the request names a legacy node. Returns false only for
// an unauthenticated user on the legacy contract, so the route falls back to the
// existing worker path unchanged. The reply has already been sent when it
// returns true (the Fastify reply is a thenable, so a reply is never returned).
export async function tryOwnedSmallUpload(
  request: FastifyRequest,
  reply: FastifyReply,
  input: OwnedSmallUploadInput,
): Promise<boolean> {
  const actor = await input.uploads.resolveActor(request);
  if (actor === null) {
    if (input.mode === "legacy") return false;
    sendUploadFailure(reply, new AttachmentUploadHttpError(401, "unauthenticated", "인증이 필요합니다"));
    return true;
  }

  const file = input.form.file;
  const sessionId = input.form.fields.get("session_id");
  if (sessionId === undefined || sessionId === "") {
    sendUploadFailure(reply, new AttachmentUploadHttpError(422, "invalid_upload", "session_id가 필요합니다"));
    return true;
  }

  let attachmentId: string;
  let checksumSha256: string | undefined;
  try {
    attachmentId = readUploadId(input.form.fields.get("upload_id"));
    checksumSha256 = readUploadChecksum(input.form.fields.get("checksum_sha256"));
  } catch (error) {
    sendUploadFailure(reply, error);
    return true;
  }

  let registration: UploadRegistration;
  try {
    registration = await input.uploads.requireRegistration(request, {
      actor,
      sessionId,
      folderId: optionalField(input.form.fields, "folder_id"),
      mode: input.mode,
      small: true,
    });
  } catch (error) {
    sendUploadFailure(reply, error);
    return true;
  }

  // The legacy contract still resolves the object through a node's cache, so a
  // missing node id is rejected as input before anything is committed.
  const nodeId = input.mode === "legacy" ? requiredNodeId(request) : null;
  if (input.mode === "legacy" && nodeId === null) {
    sendUploadFailure(reply, new AttachmentUploadHttpError(422, "invalid_upload", "nodeId가 필요합니다"));
    return true;
  }

  const spec: UploadSpec = {
    attachmentId,
    owner: { kind: "user_email", key: actor.email },
    registration,
    originalName: file.filename,
    mimeType: file.contentType,
    byteSize: file.content.length,
    ...(checksumSha256 === undefined ? {} : { checksumSha256 }),
  };

  const controller = bindAttachmentReadAbortSignal(request, reply);
  let result: CommitResult;
  try {
    result = await input.uploads.commits.putSmall({
      spec,
      body: file.content,
      signal: controller.abort.signal,
    });
  } catch (error) {
    sendUploadFailure(reply, error);
    return true;
  } finally {
    controller.cleanup();
  }

  if (input.mode === "id-v1") {
    try {
      const metadata = await input.uploads.ownerMetadata(actor, result.attachmentId, { type: "owner" });
      reply.header(UPLOAD_CONTRACT_HEADER, UPLOAD_CONTRACT_ID_V1);
      reply.code(201).send({ attachment: metadata.descriptor });
      return true;
    } catch (error) {
      sendUploadFailure(reply, error, result.attachmentId);
      return true;
    }
  }

  try {
    const legacy = await finishLegacyUpload({
      committed: result,
      // Validated as a non-empty string before the commit.
      nodeId: nodeId as string,
      repository: input.uploads.repository,
      cache: () => input.cache(nodeId as string, sessionId, file),
    });
    reply.code(201).send(legacy);
    return true;
  } catch (error) {
    sendUploadFailure(reply, error, result.attachmentId);
    return true;
  }
}

function optionalField(fields: Map<string, string>, name: string): string | null {
  const value = fields.get(name);
  return value === undefined || value === "" ? null : value;
}

function requiredNodeId(request: FastifyRequest): string | null {
  const query = request.query;
  if (typeof query !== "object" || query === null || Array.isArray(query)) return null;
  const value = (query as Record<string, unknown>).nodeId;
  return typeof value === "string" && value !== "" ? value : null;
}
