import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { verifyServiceBearerAuthorization } from "../auth/service_bearer.js";
import { AttachmentReadError } from "./attachment_read_service.js";
import {
  bindAttachmentReadAbortSignal,
  sendAttachmentReadResponse,
} from "./attachment_read_routes.js";
import type { WorkerAttachmentReadInput } from "./worker_attachment_access.js";
import { createWorkerAttachmentRead } from "./worker_attachment_read.js";

type WorkerAttachmentParams = { readonly attachment_id: string };

export type WorkerAttachmentRouteOptions = {
  readonly authBearerToken: string;
  readonly environment: string;
  readonly service: ReturnType<typeof createWorkerAttachmentRead>;
};

export const workerAttachmentRouteAuthRequirements = {
  "GET /api/attachments/worker/:attachment_id/metadata": true,
  "GET /api/attachments/worker/:attachment_id/content": true,
} as const;

const NODE_ID_HEADER = "x-soulstream-node-id";
const ALLOWED_QUERY_KEYS = new Set(["session_id", "mode", "delivery_id"]);

export function registerWorkerAttachmentRoutes(
  app: FastifyInstance,
  options: WorkerAttachmentRouteOptions,
): void {
  void app.register(async (instance) => {
    instance.addHook("onRequest", async (request, reply) => {
      const authorization = verifyServiceBearerAuthorization(
        request.headers.authorization,
        options.authBearerToken,
        options.environment,
      );
      if (!authorization.ok) {
        setPrivateReadHeaders(reply);
        return reply.code(authorization.statusCode).send({
          code: authorization.statusCode === 503
            ? "ATTACHMENT_AUTH_UNAVAILABLE"
            : "ATTACHMENT_UNAUTHORIZED",
          detail: "Attachment service authentication failed",
        });
      }
    });

    instance.get<{ Params: WorkerAttachmentParams }>(
      "/api/attachments/worker/:attachment_id/metadata",
      async (request, reply) => {
        setPrivateReadHeaders(reply);
        try {
          const input = parseWorkerAttachmentInput(request);
          return reply.send(await options.service.metadata(input));
        } catch (error) {
          return sendWorkerAttachmentError(reply, error);
        }
      },
    );

    instance.get<{ Params: WorkerAttachmentParams }>(
      "/api/attachments/worker/:attachment_id/content",
      async (request, reply) => {
        setPrivateReadHeaders(reply);
        let input: WorkerAttachmentReadInput;
        try {
          input = parseWorkerAttachmentInput(request);
        } catch (error) {
          return sendWorkerAttachmentError(reply, error);
        }

        const controller = bindAttachmentReadAbortSignal(request, reply);
        try {
          const response = await options.service.content(input, controller.abort.signal);
          return await sendAttachmentReadResponse(reply, response, controller);
        } catch (error) {
          controller.cleanup();
          return sendWorkerAttachmentError(reply, error);
        }
      },
    );
  });
}

function parseWorkerAttachmentInput(
  request: FastifyRequest<{ Params: WorkerAttachmentParams }>,
): WorkerAttachmentReadInput {
  const values = request.query;
  if (typeof values !== "object" || values === null || Array.isArray(values)) {
    throw invalidContextError();
  }
  const query = values as Record<string, unknown>;
  if (Object.keys(query).some((key) => !ALLOWED_QUERY_KEYS.has(key))) {
    throw invalidContextError();
  }

  const sessionId = requiredText(query.session_id);
  const nodeId = requiredHeader(request.headers[NODE_ID_HEADER]);
  const attachmentId = requiredText(request.params.attachment_id);
  const mode = query.mode;
  if (mode !== "input" && mode !== "resolve") throw invalidContextError();
  const deliveryId = optionalText(query.delivery_id);

  return {
    sessionId,
    nodeId,
    attachmentId,
    mode,
    ...(deliveryId === undefined ? {} : { deliveryId }),
  };
}

function requiredHeader(value: string | string[] | undefined): string {
  const header = Array.isArray(value) ? value[0] : value;
  return requiredText(header);
}

function requiredText(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) throw invalidContextError();
  return value.trim();
}

function optionalText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value);
}

function invalidContextError(): AttachmentReadError {
  return new AttachmentReadError(
    "ATTACHMENT_INVALID_CONTEXT",
    "Invalid attachment context",
    422,
  );
}

function setPrivateReadHeaders(reply: FastifyReply): void {
  reply.header("Cache-Control", "private, no-store");
  reply.header("Vary", "Authorization");
}

function sendWorkerAttachmentError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AttachmentReadError) {
    for (const [name, value] of Object.entries(error.headers ?? {})) {
      reply.header(name, value);
    }
    return reply.code(error.statusCode).send({ code: error.code, detail: error.message });
  }
  return reply.code(500).send({
    code: "ATTACHMENT_READ_FAILED",
    detail: "Attachment read failed",
  });
}
