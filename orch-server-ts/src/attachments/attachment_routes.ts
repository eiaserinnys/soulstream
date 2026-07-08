import { Buffer } from "node:buffer";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { parseMultipartForm, type MultipartFile } from "./attachment_multipart.js";

export const MAX_ATTACHMENT_SIZE_BYTES = 100 * 1024 * 1024;
export const LEGACY_ATTACHMENT_MAX_SIZE_BYTES = 8 * 1024 * 1024;
export const ATTACHMENT_UPLOAD_CHUNK_SIZE_BYTES = 1024 * 1024;

export type AttachmentNode = {
  id?: string;
  nodeId?: string;
  [key: string]: unknown;
};

export type AttachmentAccess = {
  restricted: boolean;
};

export type AttachmentAccessContext = {
  accessEmail: string | null;
};

export type AttachmentRouteProvider = {
  getNode: (nodeId: string) => Promise<AttachmentNode | null> | AttachmentNode | null;
};

export type AttachmentAccessProvider = {
  resolveAccess: (
    request: FastifyRequest,
    context: AttachmentAccessContext,
  ) => Promise<AttachmentAccess> | AttachmentAccess;
  requireSessionAccess: (input: {
    request: FastifyRequest;
    sessionId: string;
    accessEmail: string | null;
  }) => Promise<void> | void;
};

export type AttachmentUploadInput = {
  sessionId: string;
  filename: string;
  contentType: string;
  expectedSize: number;
  chunks: AsyncIterable<Buffer>;
};

export type AttachmentLegacyUploadInput = {
  sessionId: string;
  filename: string;
  contentType: string;
  contentBase64: string;
};

export type AttachmentUploadResult = {
  path: unknown;
  filename: unknown;
  size: unknown;
  content_type: unknown;
  [key: string]: unknown;
};

export type AttachmentDeleteResult = {
  cleaned?: unknown;
  files_removed?: unknown;
  [key: string]: unknown;
};

export type AttachmentDownloadResult = {
  content_b64: unknown;
  filename: unknown;
  content_type?: unknown;
  [key: string]: unknown;
};

export type AttachmentTransport = {
  uploadAttachment: (
    node: AttachmentNode,
    input: AttachmentUploadInput,
  ) => Promise<unknown> | unknown;
  legacyUploadAttachment: (
    node: AttachmentNode,
    input: AttachmentLegacyUploadInput,
  ) => Promise<unknown> | unknown;
  deleteSessionAttachments: (
    node: AttachmentNode,
    sessionId: string,
  ) => Promise<unknown> | unknown;
  downloadAttachment: (
    node: AttachmentNode,
    path: string,
  ) => Promise<unknown> | unknown;
};

export type AttachmentRouteOptions = {
  provider: AttachmentRouteProvider;
  accessProvider: AttachmentAccessProvider;
  transport: AttachmentTransport;
};

export class AttachmentRouteError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = "AttachmentRouteError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class AttachmentTransportConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentTransportConnectionError";
  }
}

export class AttachmentTransportTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentTransportTimeoutError";
  }
}

type UploadParams = Record<string, never>;
type DeleteParams = { session_id: string };

type Validation<T> =
  | { ok: true; value: T }
  | { ok: false; message: string; statusCode?: number };

export const attachmentRouteAuthRequirements = {
  "POST /api/attachments/sessions": true,
  "DELETE /api/attachments/sessions/:session_id": true,
  "GET /api/attachments/files": true,
} as const;

export function registerAttachmentRoutes(
  app: FastifyInstance,
  options: AttachmentRouteOptions,
): void {
  app.addContentTypeParser(
    /^multipart\/form-data(?:;.*)?$/i,
    { parseAs: "buffer" },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.post<{ Params: UploadParams }>("/api/attachments/sessions", async (request, reply) => {
    const nodeId = requiredQueryString(request, "nodeId");
    if (!nodeId.ok) return validationError(reply, nodeId);
    const form = parseMultipartForm(request);
    if (!form.ok) return validationError(reply, form);
    const node = await resolveNode(options.provider, nodeId.value);
    if (!node.ok) return attachmentError(reply, node.error);

    const sessionId = form.value.fields.get("session_id");
    if (sessionId === undefined || sessionId === "") {
      return reply.code(400).send({ detail: "session_id is required" });
    }
    const accessEmail = accessEmailFromCallerInfo(form.value.fields.get("caller_info") ?? null);
    const access = await ensureSessionAccess(options, request, sessionId, accessEmail);
    if (!access.ok) return attachmentError(reply, access.error);

    const file = form.value.file;
    if (file.content.length > MAX_ATTACHMENT_SIZE_BYTES) {
      return reply.code(400).send({
        detail: `파일이 너무 큽니다 (${Math.floor(file.content.length / 1024 / 1024)}MB > 100MB)`,
      });
    }

    try {
      const result = await uploadWithFallback(options, node.value, sessionId, file);
      const projected = projectUploadResult(result);
      if (!projected.ok) return attachmentError(reply, projected.error);
      return reply.code(201).send(projected.value);
    } catch (error) {
      return uploadError(reply, error);
    }
  });

  app.delete<{ Params: DeleteParams }>(
    "/api/attachments/sessions/:session_id",
    async (request, reply) => {
      const nodeId = requiredQueryString(request, "nodeId");
      if (!nodeId.ok) return validationError(reply, nodeId);
      const node = await resolveNode(options.provider, nodeId.value);
      if (!node.ok) return attachmentError(reply, node.error);

      const sessionId = request.params.session_id;
      const access = await ensureSessionAccess(options, request, sessionId, null);
      if (!access.ok) return attachmentError(reply, access.error);

      try {
        const result = await options.transport.deleteSessionAttachments(node.value, sessionId);
        if (!isPlainObject(result)) {
          return reply.code(502).send({ detail: "Node returned malformed delete response" });
        }
        return reply.send({
          cleaned: Boolean(result.cleaned ?? true),
          files_removed: integerOrDefault(result.files_removed, 0),
        });
      } catch (error) {
        return deleteError(reply, error);
      }
    },
  );

  app.get("/api/attachments/files", async (request, reply) => {
    const nodeId = requiredQueryString(request, "nodeId");
    if (!nodeId.ok) return validationError(reply, nodeId);
    const path = requiredQueryString(request, "path");
    if (!path.ok) return validationError(reply, path);
    const node = await resolveNode(options.provider, nodeId.value);
    if (!node.ok) return attachmentError(reply, node.error);

    const access = await ensureSessionAccess(options, request, parentName(path.value), null);
    if (!access.ok) return attachmentError(reply, access.error);

    try {
      const result = await options.transport.downloadAttachment(node.value, path.value);
      const projected = projectDownloadResult(result);
      if (!projected.ok) return attachmentError(reply, projected.error);
      return reply
        .header("Content-Disposition", `inline; filename="${safeHeaderFilename(projected.value.filename)}"`)
        .header("Cache-Control", "private, max-age=3600")
        .type(projected.value.contentType)
        .send(projected.value.content);
    } catch (error) {
      return downloadError(reply, error);
    }
  });
}

async function resolveNode(
  provider: AttachmentRouteProvider,
  nodeId: string,
): Promise<{ ok: true; value: AttachmentNode } | { ok: false; error: AttachmentRouteError }> {
  const node = await provider.getNode(nodeId);
  if (node === null) {
    return {
      ok: false,
      error: new AttachmentRouteError("NODE_NOT_FOUND", `Node '${nodeId}' not found`, 404),
    };
  }
  return { ok: true, value: node };
}

async function ensureSessionAccess(
  options: AttachmentRouteOptions,
  request: FastifyRequest,
  sessionId: string,
  accessEmail: string | null,
): Promise<{ ok: true } | { ok: false; error: AttachmentRouteError }> {
  try {
    const access = await options.accessProvider.resolveAccess(request, { accessEmail });
    if (access.restricted) {
      await options.accessProvider.requireSessionAccess({ request, sessionId, accessEmail });
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: routeErrorFromUnknown(error, 403),
    };
  }
}

async function uploadWithFallback(
  options: AttachmentRouteOptions,
  node: AttachmentNode,
  sessionId: string,
  file: MultipartFile,
): Promise<unknown> {
  try {
    return await options.transport.uploadAttachment(node, {
      sessionId,
      filename: file.filename,
      contentType: file.contentType,
      expectedSize: file.content.length,
      chunks: iterAttachmentChunks(file.content),
    });
  } catch (error) {
    if (!isChunkedUploadUnsupported(errorMessage(error))) throw error;
    if (file.content.length > LEGACY_ATTACHMENT_MAX_SIZE_BYTES) {
      throw new AttachmentRouteError(
        "LEGACY_UPLOAD_TOO_LARGE",
        "Node does not support chunked attachment upload and file exceeds legacy 8MB limit",
        502,
      );
    }
    return await options.transport.legacyUploadAttachment(node, {
      sessionId,
      filename: file.filename,
      contentType: file.contentType,
      contentBase64: file.content.toString("base64"),
    });
  }
}

async function* iterAttachmentChunks(content: Buffer): AsyncIterable<Buffer> {
  for (let offset = 0; offset < content.length; offset += ATTACHMENT_UPLOAD_CHUNK_SIZE_BYTES) {
    yield content.subarray(offset, offset + ATTACHMENT_UPLOAD_CHUNK_SIZE_BYTES);
  }
}

function requiredQueryString(request: FastifyRequest, name: string): Validation<string> {
  const query = request.query;
  const value = isPlainObject(query) ? query[name] : undefined;
  if (typeof value !== "string" || value === "") {
    return { ok: false, message: `${name} is required`, statusCode: 422 };
  }
  return { ok: true, value };
}

function accessEmailFromCallerInfo(callerInfo: string | null): string | null {
  if (callerInfo === null) return null;
  try {
    const parsed: unknown = JSON.parse(callerInfo);
    if (isPlainObject(parsed) && typeof parsed.email === "string") return parsed.email;
  } catch {
    return null;
  }
  return null;
}

function projectUploadResult(result: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; error: AttachmentRouteError } {
  if (
    !isPlainObject(result) ||
    typeof result.path !== "string" ||
    typeof result.filename !== "string" ||
    typeof result.size !== "number" ||
    !Number.isInteger(result.size) ||
    typeof result.content_type !== "string"
  ) {
    return {
      ok: false,
      error: new AttachmentRouteError(
        "MALFORMED_UPLOAD_RESPONSE",
        "Node returned malformed upload response",
        502,
      ),
    };
  }
  return {
    ok: true,
    value: {
      path: result.path,
      filename: result.filename,
      size: result.size,
      content_type: result.content_type,
    },
  };
}

function projectDownloadResult(
  result: unknown,
): { ok: true; value: { content: Buffer; filename: string; contentType: string } } | { ok: false; error: AttachmentRouteError } {
  const object = isPlainObject(result) ? result : {};
  const contentB64 = object.content_b64;
  const filename = object.filename;
  if (typeof contentB64 !== "string" || typeof filename !== "string") {
    return {
      ok: false,
      error: new AttachmentRouteError(
        "MALFORMED_DOWNLOAD_RESPONSE",
        "Node returned malformed download response",
        502,
      ),
    };
  }
  const decoded = decodeBase64(contentB64);
  if (!decoded.ok) return { ok: false, error: decoded.error };
  const contentType = typeof object.content_type === "string" ? object.content_type : "application/octet-stream";
  return { ok: true, value: { content: decoded.value, filename, contentType } };
}

function decodeBase64(value: string): { ok: true; value: Buffer } | { ok: false; error: AttachmentRouteError } {
  const normalized = value.trim();
  if (normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    return invalidBase64Error("invalid base64");
  }
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.toString("base64").replace(/=+$/, "") !== normalized.replace(/=+$/, "")) {
    return invalidBase64Error("invalid base64");
  }
  return { ok: true, value: decoded };
}

function invalidBase64Error(reason: string): { ok: false; error: AttachmentRouteError } {
  return {
    ok: false,
    error: new AttachmentRouteError(
      "INVALID_BASE64",
      `Node returned invalid base64: ${reason}`,
      502,
    ),
  };
}

function uploadError(reply: FastifyReply, error: unknown): FastifyReply {
  return mappedTransportError(reply, error, {
    timeout: "Node attachment upload timed out",
    failure: "Node attachment upload failed",
  });
}

function deleteError(reply: FastifyReply, error: unknown): FastifyReply {
  return mappedTransportError(reply, error, {
    timeout: "Node attachment delete timed out",
    failure: "Node attachment delete failed",
  });
}

function downloadError(reply: FastifyReply, error: unknown): FastifyReply {
  return mappedTransportError(reply, error, {
    timeout: "Node download timed out",
    failure: "Node download failed",
    notFoundPrefix: "NOT_FOUND:",
  });
}

function mappedTransportError(
  reply: FastifyReply,
  error: unknown,
  messages: { timeout: string; failure: string; notFoundPrefix?: string },
): FastifyReply {
  if (error instanceof AttachmentRouteError) return attachmentError(reply, error);
  if (error instanceof AttachmentTransportConnectionError) {
    return reply.code(503).send({ detail: `Node temporarily unavailable: ${error.message}` });
  }
  if (error instanceof AttachmentTransportTimeoutError) {
    return reply.code(504).send({ detail: `${messages.timeout}: ${error.message}` });
  }
  const message = errorMessage(error);
  if (messages.notFoundPrefix !== undefined && message.startsWith(messages.notFoundPrefix)) {
    return reply.code(404).send({ detail: message.slice(messages.notFoundPrefix.length).trim() });
  }
  if (message.startsWith("INVALID_REQUEST:")) {
    return reply.code(400).send({ detail: message.slice("INVALID_REQUEST:".length).trim() });
  }
  return reply.code(502).send({ detail: `${messages.failure}: ${message}` });
}

function attachmentError(reply: FastifyReply, error: AttachmentRouteError): FastifyReply {
  return reply.code(error.statusCode).send({ detail: error.message });
}

function validationError<T>(reply: FastifyReply, result: Extract<Validation<T>, { ok: false }>): FastifyReply {
  return reply.code(result.statusCode ?? 400).send({ detail: result.message });
}

function routeErrorFromUnknown(error: unknown, fallbackStatusCode: number): AttachmentRouteError {
  if (error instanceof AttachmentRouteError) return error;
  return new AttachmentRouteError("ATTACHMENT_ROUTE_ERROR", errorMessage(error), fallbackStatusCode);
}

function isChunkedUploadUnsupported(message: string): boolean {
  return (
    message.includes("upload_attachment_start") &&
    (message.includes("Not implemented") || message.includes("Unknown command"))
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integerOrDefault(value: unknown, fallback: number): number {
  const numberValue = Number(value ?? fallback);
  return Number.isFinite(numberValue) ? Math.trunc(numberValue) : fallback;
}

function parentName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]+/);
  return parts.length >= 2 ? parts[parts.length - 2] ?? "" : "";
}

function safeHeaderFilename(filename: string): string {
  return filename.replace(/["\\\r\n]/g, "_");
}
