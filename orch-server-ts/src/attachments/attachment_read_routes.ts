import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AttachmentReadContext } from "@soulstream/wire-schema/attachments";
import {
  AttachmentReadError,
  attachmentReadContext,
  attachmentReadContextFromOptionalQuery,
  type AttachmentReadActor,
  type AttachmentReadService,
} from "./attachment_read_service.js";

export type AttachmentReadRouteOptions = {
  readonly resolveActor: (request: FastifyRequest) => Promise<AttachmentReadActor>;
  readonly service: AttachmentReadService;
};

type AttachmentReadParams = { attachment_id: string };

export const attachmentReadRouteAuthRequirements = {
  "GET /api/attachments/:attachment_id": true,
  "GET /api/attachments/:attachment_id/content": true,
  "HEAD /api/attachments/:attachment_id/content": true,
} as const;

export function registerAttachmentReadRoutes(
  app: FastifyInstance,
  options: AttachmentReadRouteOptions,
): void {
  app.get<{ Params: AttachmentReadParams }>(
    "/api/attachments/:attachment_id",
    async (request, reply) => {
      setPrivateReadHeaders(reply);
      const query = readQuery(request);
      if (!query.ok) return validationError(reply, query.error);
      let context: AttachmentReadContext;
      try {
        context = attachmentReadContext(query.value.contextType, query.value.contextId);
      } catch (error) {
        return sendAttachmentReadError(reply, error);
      }
      try {
        const actor = await options.resolveActor(request);
        const metadata = await options.service.metadata(
          actor,
          request.params.attachment_id,
          context,
        );
        return reply.send(metadata);
      } catch (error) {
        return sendAttachmentReadError(reply, error);
      }
    },
  );

  const sendContent = async (request: FastifyRequest, reply: FastifyReply) => {
    setPrivateReadHeaders(reply);
    const query = readQuery(request);
    if (!query.ok) return validationError(reply, query.error);
    let context: AttachmentReadContext;
    try {
      context = attachmentReadContext(query.value.contextType, query.value.contextId);
    } catch (error) {
      return sendAttachmentReadError(reply, error);
    }
    const download = parseDownload(query.value.download);
    if (!download.ok) return validationError(reply, download.error);
    if (request.method === "GET" && request.headers["sec-fetch-dest"] === "document" && !download.value) {
      const params = [`attachment=${encodeURIComponent((request.params as AttachmentReadParams).attachment_id)}`];
      if (query.value.contextType !== undefined) {
        params.push(`context_type=${encodeURIComponent(query.value.contextType)}`);
      }
      if (query.value.contextId !== undefined) {
        params.push(`context_id=${encodeURIComponent(query.value.contextId)}`);
      }
      return reply.code(303).header("location", `/?${params.join("&")}`).send();
    }
    const controller = bindAttachmentReadAbortSignal(request, reply);
    try {
      const actor = await options.resolveActor(request);
      const response = await options.service.content(
        actor,
        (request.params as AttachmentReadParams).attachment_id,
        context,
        {
          method: request.method === "HEAD" ? "HEAD" : "GET",
          ...(request.method === "GET" && typeof request.headers.range === "string"
            ? { range: request.headers.range }
            : {}),
          signal: controller.abort.signal,
          ...(download.value ? { download: true } : {}),
        },
      );
      return sendReadResponse(reply, response, controller);
    } catch (error) {
      controller.cleanup();
      return sendAttachmentReadError(reply, error);
    }
  };

  app.route<{ Params: AttachmentReadParams }>({
    method: ["GET", "HEAD"],
    url: "/api/attachments/:attachment_id/content",
    handler: sendContent,
  });
}

export async function sendAttachmentReadResponse(
  reply: FastifyReply,
  response: Response,
  controller?: { readonly cleanup: () => void; readonly abort: AbortController },
): Promise<FastifyReply> {
  return sendReadResponse(reply, response, controller);
}

function sendReadResponse(
  reply: FastifyReply,
  response: Response,
  controller?: { readonly cleanup: () => void; readonly abort: AbortController },
): FastifyReply {
  for (const name of [
    "content-type",
    "content-length",
    "content-disposition",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
    "x-content-type-options",
  ]) {
    const value = response.headers.get(name);
    if (value !== null) reply.header(name, value);
  }
  reply.code(response.status);
  if (response.body === null) {
    controller?.cleanup();
    return reply.send();
  }
  const stream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
  stream.once("error", () => {
    reply.log.warn({ code: "ATTACHMENT_STREAM_FAILED" }, "Attachment response stream failed");
    controller?.cleanup();
  });
  if (controller !== undefined) {
    stream.once("close", controller.cleanup);
    stream.once("end", controller.cleanup);
  }
  return reply.send(stream);
}

export function bindAttachmentReadAbortSignal(
  request: FastifyRequest,
  reply: FastifyReply,
): { readonly abort: AbortController; readonly cleanup: () => void } {
  const abort = new AbortController();
  const onAborted = () => abort.abort();
  const onClose = () => {
    if (!reply.raw.writableFinished) abort.abort();
  };
  request.raw.once("aborted", onAborted);
  reply.raw.once("close", onClose);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    request.raw.off("aborted", onAborted);
    reply.raw.off("close", onClose);
  };
  return { abort, cleanup };
}

function setPrivateReadHeaders(reply: FastifyReply): void {
  reply.header("Cache-Control", "private, no-store");
  const existing = reply.getHeader("Vary");
  const vary = typeof existing === "string" ? existing : "";
  const values = new Set(vary.split(",").map((value) => value.trim()).filter(Boolean));
  values.add("Cookie");
  values.add("Authorization");
  reply.header("Vary", [...values].join(", "));
}

function readQuery(request: FastifyRequest):
  | { readonly ok: true; readonly value: { contextType?: string; contextId?: string; download?: string } }
  | { readonly ok: false; readonly error: string } {
  const query = request.query;
  if (typeof query !== "object" || query === null || Array.isArray(query)) {
    return { ok: false, error: "Invalid attachment query" };
  }
  const values = query as Record<string, unknown>;
  const contextType = queryValue(values.context_type);
  const contextId = queryValue(values.context_id);
  const download = queryValue(values.download);
  if (!contextType.ok || !contextId.ok || !download.ok) {
    return { ok: false, error: "Invalid attachment query" };
  }
  return {
    ok: true,
    value: {
      ...(contextType.value === undefined ? {} : { contextType: contextType.value }),
      ...(contextId.value === undefined ? {} : { contextId: contextId.value }),
      ...(download.value === undefined ? {} : { download: download.value }),
    },
  };
}

export function readOptionalAttachmentContext(
  request: FastifyRequest,
): { readonly ok: true; readonly context: AttachmentReadContext | undefined } | { readonly ok: false; readonly error: string } {
  const query = readQuery(request);
  if (!query.ok) return query;
  try {
    return {
      ok: true,
      context: attachmentReadContextFromOptionalQuery(
        query.value.contextType,
        query.value.contextId,
      ),
    };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function parseDownload(value: string | undefined):
  | { readonly ok: true; readonly value: boolean }
  | { readonly ok: false; readonly error: string } {
  if (value === undefined || value === "false") return { ok: true, value: false };
  if (value === "true") return { ok: true, value: true };
  return { ok: false, error: "download must be true or false" };
}

function queryValue(value: unknown): { readonly ok: true; readonly value: string | undefined } | { readonly ok: false } {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string" || value.length === 0) return { ok: false };
  return { ok: true, value };
}

function validationError(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({ detail: message });
}

export function sendAttachmentReadError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AttachmentReadError) {
    for (const [name, value] of Object.entries(error.headers ?? {})) {
      reply.header(name, value);
    }
    return reply.code(error.statusCode).send({ detail: error.message });
  }
  const statusCode = statusFromError(error);
  if (statusCode !== undefined && statusCode < 500) {
    return reply.code(statusCode).send({ detail: safeErrorDetail(statusCode) });
  }
  return reply.code(503).send({ detail: "Attachment read is unavailable" });
}

function statusFromError(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return undefined;
  const value = error.statusCode;
  return typeof value === "number" && value >= 400 && value <= 599 ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeErrorDetail(statusCode: number): string {
  if (statusCode === 401) return "Authentication required";
  if (statusCode === 404) return "Attachment scope not found";
  if (statusCode === 403) return "Attachment access denied";
  return "Attachment request failed";
}
