import { randomUUID } from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";

import { isUuid } from "../http/uuid.js";
import type {
  AttachmentCommitRepository,
  AttachmentStorageBinding,
  OwnedAttachmentCommitService,
  UploadRegistration,
} from "./attachment_commit_contract.js";
import type { AttachmentReadActor, AttachmentReadService } from "./attachment_read_service.js";

// Upload contract header: the only explicitly accepted value selects the id-v1
// contract; an absent header defers to the ticket's own contract (legacy default).
export const UPLOAD_CONTRACT_HEADER = "x-soulstream-attachment-contract";
export const UPLOAD_CONTRACT_ID_V1 = "id-v1";

const MASKED_DETAIL = "첨부 저장에 실패했습니다";

export type UploadMode = "legacy" | "id-v1";
export type UserUploadActor = Extract<AttachmentReadActor, { kind: "user" }>;

export type LegacyUploadResult = { path: string; filename: string; size: number; content_type: string };

// Port for the owned upload HTTP boundary. The route layer injects one and the
// live provider supplies the authorization, registration and storage wiring.
export type AttachmentUploadOptions = {
  readonly resolveActor: (request: FastifyRequest) => Promise<UserUploadActor | null>;
  readonly requireRegistration: (
    request: FastifyRequest,
    input: {
      readonly actor: UserUploadActor;
      readonly sessionId: string;
      readonly folderId: string | null;
      readonly mode: UploadMode;
      readonly small: boolean;
    },
  ) => Promise<UploadRegistration>;
  readonly commits: OwnedAttachmentCommitService;
  readonly repository: AttachmentCommitRepository;
  readonly resolveBinding: () => Promise<AttachmentStorageBinding | null>;
  readonly ownerMetadata: AttachmentReadService["metadata"];
};

export class AttachmentUploadHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    readonly detail: string,
  ) {
    super(detail);
    this.name = "AttachmentUploadHttpError";
  }
}

export function readUploadMode(request: FastifyRequest, ticketMode?: UploadMode): UploadMode {
  const raw = request.headers[UPLOAD_CONTRACT_HEADER];
  if (raw === undefined) return ticketMode ?? "legacy";
  const value = Array.isArray(raw) ? raw.join(",") : raw;
  if (value.includes(",") || value !== UPLOAD_CONTRACT_ID_V1) {
    throw new AttachmentUploadHttpError(400, "invalid_upload_contract", "지원하지 않는 첨부 업로드 계약입니다");
  }
  if (ticketMode !== undefined && ticketMode !== UPLOAD_CONTRACT_ID_V1) {
    throw new AttachmentUploadHttpError(409, "upload_contract_conflict", "첨부 업로드 계약이 ticket과 충돌합니다");
  }
  return UPLOAD_CONTRACT_ID_V1;
}

export function readUploadId(value: unknown): string {
  if (value === undefined) return randomUUID();
  if (!isUuid(value)) {
    throw new AttachmentUploadHttpError(400, "invalid_upload", "upload_id 형식이 올바르지 않습니다");
  }
  return value;
}

export function readUploadChecksum(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new AttachmentUploadHttpError(400, "invalid_upload", "checksum 형식이 올바르지 않습니다");
  }
  return value.toLowerCase();
}

export function sendUploadFailure(reply: FastifyReply, error: unknown, attachmentId?: string): FastifyReply {
  if (error instanceof AttachmentUploadHttpError) {
    return sendUploadError(reply, error.statusCode, error.code, error.detail, attachmentId);
  }
  if (isSafeRouteError(error)) {
    return sendUploadError(reply, error.statusCode, error.code, safeDetail(error), attachmentId ?? error.attachmentId);
  }
  return sendUploadError(reply, 502, "storage_failed", MASKED_DETAIL, attachmentId);
}

function sendUploadError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  detail: string,
  attachmentId?: string,
): FastifyReply {
  const body: { detail: string; code: string; attachment_id?: string } = { detail, code };
  if (attachmentId !== undefined && attachmentId !== "") body.attachment_id = attachmentId;
  return reply.code(statusCode).send(body);
}

// A route error is safe only when it carries both a numeric status and a string
// code. Anything else (including transport exceptions) becomes a masked 502 so
// raw URLs, headers or tokens are never serialized into the response.
function isSafeRouteError(error: unknown): error is { statusCode: number; code: string; detail?: string; attachmentId?: string } {
  return error instanceof Error
    && "statusCode" in error && typeof (error as { statusCode?: unknown }).statusCode === "number"
    && "code" in error && typeof (error as { code?: unknown }).code === "string";
}

function safeDetail(error: { detail?: string }): string {
  return typeof error.detail === "string" && error.detail.length > 0 ? error.detail : MASKED_DETAIL;
}
