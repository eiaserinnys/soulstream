import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { AdminAccessProvider } from "../admin/admin_access.js";
import type { ExternalInputDispatchLogger } from "../external_access/external_input_service.js";
import {
  inboundWebhookIdSchema,
  inboundWebhookIssueSchema,
  inboundWebhookRequestsQuerySchema,
  issueInboundWebhook,
  listInboundWebhookRequests,
  listInboundWebhooks,
  normalizeWebhookOwnerEmail,
  revokeInboundWebhook,
  type InboundWebhookManagement,
} from "./webhook_management.js";

/**
 * Inbound webhook management API (design 4.1).
 *
 * Signed-in users issue inbound webhooks, list their own webhooks with a recent
 * receive summary, read one webhook's recent requests, and revoke one. The raw
 * secret leaves the store only in the issue response; no read carries key
 * material. Every route requires login, and the target session judgment is the
 * same one `access_link_routes.ts` uses for links. The commands live in
 * `webhook_management.ts`, shared with the MCP webhook tools.
 */

export const inboundWebhookRouteAuthRequirements = {
  "POST /api/webhooks/inbound": true,
  "GET /api/webhooks/inbound": true,
  "GET /api/webhooks/inbound/:id/requests": true,
  "DELETE /api/webhooks/inbound/:id": true,
} as const;

export type InboundWebhookRouteOptions =
  & Pick<AdminAccessProvider, "currentEmail">
  & InboundWebhookManagement
  & {
    /** Test seam: production logs through the request logger. */
    logger?: ExternalInputDispatchLogger;
  };

class InboundWebhookRouteError extends Error {
  constructor(readonly statusCode: 401 | 404, message: string) {
    super(message);
    this.name = "InboundWebhookRouteError";
  }
}

export function registerInboundWebhookRoutes(
  app: FastifyInstance,
  options: InboundWebhookRouteOptions,
): void {
  void app.register(async (instance) => {
    // Every answer of this surface, including parser failures, is uncacheable.
    instance.addHook("onSend", async (_request, reply, payload) => {
      reply.header("cache-control", "no-store");
      return payload;
    });
    // Body parser and other pre-handler failures never reach a route handler.
    instance.setErrorHandler((error, request, reply) => {
      const status = parserErrorStatus(error);
      if (status === 503) logSafeFailure(options, request, error);
      return reply.code(status).send({ detail: detailForStatus(status) });
    });

    instance.post("/api/webhooks/inbound", async (request, reply) => {
      try {
        const email = await requireEmail(options, request);
        const input = inboundWebhookIssueSchema.parse(request.body ?? {});
        const issued = await issueInboundWebhook(options, email, input);
        if (!issued.ok) throw new InboundWebhookRouteError(404, "Session not found");
        reply.code(201);
        return issued.value;
      } catch (error) {
        return sendRouteError(options, request, reply, error);
      }
    });

    instance.get("/api/webhooks/inbound", async (request, reply) => {
      try {
        const email = await requireEmail(options, request);
        return await listInboundWebhooks(options, email);
      } catch (error) {
        return sendRouteError(options, request, reply, error);
      }
    });

    instance.get<{
      Params: { id: string };
      Querystring: Record<string, unknown>;
    }>("/api/webhooks/inbound/:id/requests", async (request, reply) => {
      try {
        const email = await requireEmail(options, request);
        const { id } = inboundWebhookIdSchema.parse(request.params);
        const { limit } = inboundWebhookRequestsQuerySchema.parse(request.query ?? {});
        const listed = await listInboundWebhookRequests(options, email, id, limit);
        if (!listed.ok) throw new InboundWebhookRouteError(404, "Inbound webhook not found");
        return listed.value;
      } catch (error) {
        return sendRouteError(options, request, reply, error);
      }
    });

    instance.delete<{ Params: { id: string } }>(
      "/api/webhooks/inbound/:id",
      async (request, reply) => {
        try {
          const email = await requireEmail(options, request);
          const { id } = inboundWebhookIdSchema.parse(request.params);
          const revoked = await revokeInboundWebhook(options, email, id);
          if (!revoked.ok) {
            throw new InboundWebhookRouteError(404, "Inbound webhook not found");
          }
          return revoked.value;
        } catch (error) {
          return sendRouteError(options, request, reply, error);
        }
      },
    );
  });
}

async function requireEmail(
  options: InboundWebhookRouteOptions,
  request: FastifyRequest,
): Promise<string> {
  const email = normalizeWebhookOwnerEmail(await options.currentEmail(request));
  if (!email) throw new InboundWebhookRouteError(401, "Authentication required");
  return email;
}

function sendRouteError(
  options: InboundWebhookRouteOptions,
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
) {
  const status = error instanceof InboundWebhookRouteError
    ? error.statusCode
    : error instanceof z.ZodError
    ? 422
    : 503;
  if (status === 503) logSafeFailure(options, request, error);
  return reply.code(status).send({
    detail: error instanceof InboundWebhookRouteError
      ? error.message
      : detailForStatus(status),
  });
}

function detailForStatus(status: number): string {
  switch (status) {
    case 422:
      return "Invalid inbound webhook request";
    default:
      return "Inbound webhook storage temporarily unavailable";
  }
}

/** A body that fails to parse is an invalid request, not a storage failure. */
function parserErrorStatus(error: unknown): 422 | 503 {
  const statusCode = typeof error === "object" && error !== null
    ? (error as { statusCode?: unknown }).statusCode
    : undefined;
  return statusCode === 400 || statusCode === 413 || statusCode === 415
    ? 422
    : 503;
}

/**
 * Logs only a safe classification: the error code (SQLSTATE for database
 * errors), the constraint name and the error name. The body, the key and
 * signing secrets, the error message and detail never reach the log.
 */
function logSafeFailure(
  options: InboundWebhookRouteOptions,
  request: FastifyRequest,
  error: unknown,
): void {
  const fields: Record<string, unknown> = {
    method: request.method,
    route: request.routeOptions.url ?? null,
  };
  if (typeof error === "object" && error !== null) {
    const candidate = error as {
      code?: unknown;
      constraint?: unknown;
      name?: unknown;
    };
    if (typeof candidate.code === "string" || typeof candidate.code === "number") {
      fields.error_code = String(candidate.code);
    }
    if (typeof candidate.constraint === "string") {
      fields.constraint = candidate.constraint;
    }
    if (typeof candidate.name === "string") fields.error_name = candidate.name;
  }
  const logger: ExternalInputDispatchLogger = options.logger ?? {
    warn: (logFields, message) => request.log.warn(logFields, message),
  };
  logger.warn(fields, "Inbound webhook management request failed");
}
