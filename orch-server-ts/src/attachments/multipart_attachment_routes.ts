import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AttachmentR2Storage } from "../runtime/live_board_asset_storage.js";
import {
  ATTACHMENT_TICKET_SECONDS, LARGE_ATTACHMENT_MAX_SIZE, LARGE_ATTACHMENT_PART_SIZE,
  issueAttachmentTicket, verifyAttachmentTicket, type AttachmentUploadTicket,
} from "./attachment_upload_ticket.js";

export interface AttachmentImportInput {
  uploadId: string; sessionId: string; filename: string; contentType: string;
  expectedSize: number; downloadUrl: string;
}
export interface MultipartAttachmentOptions {
  resolveStorage(): Promise<{ storage: AttachmentR2Storage; identity: string } | null>;
  resolveSecret(): Promise<string>;
  resolveEmail(request: FastifyRequest): Promise<string | null>;
  requireAccess(request: FastifyRequest, sessionId: string, folderId: string | null): Promise<void>;
  getNode(nodeId: string): Promise<{ capabilities?: Record<string, unknown> } | null>;
  importAttachment(nodeId: string, input: AttachmentImportInput, signal: AbortSignal): Promise<unknown>;
  abortImport(nodeId: string, uploadId: string): Promise<unknown>;
}
class UploadError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); }
}
const prefix = "/api/attachments/sessions/multipart";
export const multipartAttachmentRouteAuthRequirements = {
  [`POST ${prefix}/init`]: true,
  [`POST ${prefix}/complete`]: true,
  [`POST ${prefix}/abort`]: true,
};
export function registerMultipartAttachmentRoutes(app: FastifyInstance, options: MultipartAttachmentOptions): void {
  app.post(`${prefix}/init`, async (request, reply) => {
    try {
      const nodeId = requestNodeId(request);
      const email = await authenticatedEmail(request);
      const body = object(request.body);
      const sessionId = text(body.session_id, "session_id");
      const filename = text(body.filename, "filename");
      const size = body.size;
      if (!Number.isSafeInteger(size) || (size as number) <= 0 || (size as number) > LARGE_ATTACHMENT_MAX_SIZE) {
        throw new UploadError("파일 크기는 0보다 크고 5GiB 이하여야 합니다");
      }
      const contentType = text(body.content_type, "content_type");
      const folderId = body.folder_id == null ? null : text(body.folder_id, "folder_id");
      await options.requireAccess(request, sessionId, folderId);
      await requireWorker(nodeId);
      const binding = await requireStorage();
      const importId = randomUUID();
      const storageKey = `session-attachments/transfers/${importId}`;
      const multipart = await binding.storage.createMultipartUpload({ storageKey, mimeType: contentType,
        byteSize: size as number, partSize: LARGE_ATTACHMENT_PART_SIZE, expiresSeconds: ATTACHMENT_TICKET_SECONDS });
      const ticket = issueAttachmentTicket({ purpose: "session_attachment_upload", sub: email,
        sessionId, folderId, nodeId, storageKey, uploadId: multipart.uploadId, importId, filename,
        size: size as number, contentType, settingsIdentity: binding.identity,
        exp: Math.floor(Date.now() / 1000) + ATTACHMENT_TICKET_SECONDS }, await options.resolveSecret());
      return reply.code(201).send({ ticket, partSize: multipart.partSize, parts: multipart.parts });
    } catch (error) { return fail(reply, error); }
  });
  app.post(`${prefix}/complete`, async (request, reply) => {
    const controller = new AbortController();
    const onClose = () => { if (!reply.raw.writableFinished) controller.abort(); };
    reply.raw.on("close", onClose);
    try {
      const body = object(request.body);
      const { ticket, storage } = await verifyRequest(request, body);
      await requireWorker(ticket.nodeId);
      const parts = completedParts(body.parts, Math.ceil(ticket.size / LARGE_ATTACHMENT_PART_SIZE));
      controller.signal.throwIfAborted();
      await storage.completeMultipartUpload({ storageKey: ticket.storageKey, uploadId: ticket.uploadId, parts });
      if ((await storage.headObject({ storageKey: ticket.storageKey })).byteSize !== ticket.size) {
        throw new UploadError("R2 첨부 크기가 업로드 요청과 다릅니다");
      }
      const downloadUrl = await storage.createPresignedGetUrl({ storageKey: ticket.storageKey, expiresSeconds: ATTACHMENT_TICKET_SECONDS });
      const result = await options.importAttachment(ticket.nodeId, {
        downloadUrl, expectedSize: ticket.size, sessionId: ticket.sessionId,
        filename: ticket.filename, contentType: ticket.contentType, uploadId: ticket.importId,
      }, controller.signal);
      await storage.deleteObject({ storageKey: ticket.storageKey }).catch(() => undefined);
      return reply.code(201).send(result);
    } catch (error) { return fail(reply, error); }
    finally { reply.raw.off("close", onClose); }
  });
  app.post(`${prefix}/abort`, async (request, reply) => {
    try {
      const { ticket, storage } = await verifyRequest(request, object(request.body));
      await Promise.allSettled([
        storage.abortMultipartUpload({ storageKey: ticket.storageKey, uploadId: ticket.uploadId }),
        options.abortImport(ticket.nodeId, ticket.importId),
      ]);
      return reply.send({ aborted: true });
    } catch (error) { return fail(reply, error); }
  });
  async function authenticatedEmail(request: FastifyRequest) {
    const email = await options.resolveEmail(request);
    if (!email) throw new UploadError("로그인이 필요합니다", 401);
    return email;
  }
  async function requireStorage() {
    const binding = await options.resolveStorage();
    if (!binding) throw new UploadError("대용량 첨부용 R2 설정이 필요합니다", 503);
    return binding;
  }
  async function requireWorker(nodeId: string) {
    const node = await options.getNode(nodeId);
    if (!node) throw new UploadError("첨부 대상 노드가 연결되지 않았습니다", 503);
    if (node.capabilities?.attachment_import_v1 !== true) throw new UploadError("첨부 대상 워커가 대용량 첨부를 지원하지 않습니다. 워커 업데이트가 필요합니다", 409);
  }
  async function verifyRequest(request: FastifyRequest, body: Record<string, unknown>) {
    const nodeId = requestNodeId(request);
    const email = await authenticatedEmail(request);
    const ticket = verifyAttachmentTicket(text(body.ticket, "ticket"), await options.resolveSecret());
    if (!ticket) throw new UploadError("첨부 업로드 ticket이 만료되었거나 올바르지 않습니다", 403);
    if (ticket.sub !== email || ticket.nodeId !== nodeId) throw new UploadError("첨부 업로드 ticket의 사용자 또는 노드가 다릅니다", 403);
    await options.requireAccess(request, ticket.sessionId, ticket.folderId);
    const binding = await requireStorage();
    if (binding.identity !== ticket.settingsIdentity) throw new UploadError("첨부 저장소 설정이 변경되었습니다. 다시 업로드해 주세요", 409);
    return { ticket, storage: binding.storage };
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UploadError("JSON 객체가 필요합니다");
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new UploadError(`${name}이 필요합니다`);
  return value;
}
function requestNodeId(request: FastifyRequest): string { return text(object(request.query).nodeId, "nodeId"); }
function completedParts(value: unknown, count: number) {
  if (!Array.isArray(value) || value.length !== count) throw new UploadError("업로드 part 개수가 올바르지 않습니다");
  return value.map((raw, index) => {
    const part = object(raw);
    if (part.partNumber !== index + 1 || typeof part.etag !== "string" || !/^"?[a-zA-Z0-9-]+"?$/.test(part.etag)) {
      throw new UploadError("업로드 part 번호 또는 ETag가 올바르지 않습니다");
    }
    return { partNumber: index + 1, etag: part.etag };
  });
}
function fail(reply: import("fastify").FastifyReply, error: unknown) {
  const status = error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 502;
  return reply.code(status).send({ detail: error instanceof Error ? error.message : "첨부 업로드 실패" });
}
