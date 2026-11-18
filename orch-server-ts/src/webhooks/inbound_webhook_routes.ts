import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { AdminAccessProvider } from "../admin/admin_access.js";
import { SERVICE_CALLER } from "../auth/service_caller.js";
import type {
  ExternalAccessGrantRepository,
  ExternalAccessGrantSummary,
} from "../external_access/external_access_grant_repository.js";
import type {
  ExternalGrantRecentSummary,
  ExternalInputDispatchLogger,
  ExternalInputService,
} from "../external_access/external_input_service.js";
import {
  SessionResourceAccessError,
  type SessionRequestAccessGuard,
} from "../session/session_resource_access.js";

/**
 * Inbound webhook management API (design 4.1).
 *
 * Signed-in users issue inbound webhooks, list their own webhooks with a recent
 * receive summary, read one webhook's recent requests, and revoke one. The raw
 * secret leaves the store only in the issue response; no read carries key
 * material. Every route requires login, and the target session judgment is the
 * same one `access_link_routes.ts` uses for links.
 */

export const inboundWebhookRouteAuthRequirements = {
  "POST /api/webhooks/inbound": true,
  "GET /api/webhooks/inbound": true,
  "GET /api/webhooks/inbound/:id/requests": true,
  "DELETE /api/webhooks/inbound/:id": true,
} as const;

export type InboundWebhookRouteOptions = Pick<AdminAccessProvider, "currentEmail"> & {
  grants: Pick<
    ExternalAccessGrantRepository,
    "issueInboundWebhook" | "list" | "revoke" | "findOwned"
  >;
  requests: Pick<ExternalInputService, "listRecentRequests" | "summarizeGrants">;
  requireSessionAccess: SessionRequestAccessGuard["requireSessionAccess"];
  /** Public origin the receive URLs are built from; trailing slashes collapse. */
  publicUrl: string;
  /** Test seam: production logs through the request logger. */
  logger?: ExternalInputDispatchLogger;
};

const PREAMBLE_MAX_LENGTH = 4000;
const MAX_EXPIRES_IN_SECONDS = 365 * 24 * 60 * 60;
const DEFAULT_REQUESTS_LIMIT = 20;
const MAX_REQUESTS_LIMIT = 50;

const issueBodySchema = z
  .object({
    target_session_id: z.uuid(),
    label: z.string().trim().min(1).max(80),
    auth_mode: z.enum(["key", "signature"]),
    preamble: z.string().max(PREAMBLE_MAX_LENGTH).nullable().optional(),
    expires_in_seconds: z
      .number()
      .int()
      .min(60)
      .max(MAX_EXPIRES_IN_SECONDS)
      .nullable()
      .optional(),
  })
  .strict();

const grantIdParamsSchema = z.object({ id: z.uuid() }).strict();

const requestsQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_REQUESTS_LIMIT)
    .default(DEFAULT_REQUESTS_LIMIT),
});

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
        const input = issueBodySchema.parse(request.body ?? {});
        await requireTargetSessionAccess(options, email, input.target_session_id);
        const issued = await options.grants.issueInboundWebhook({
          ownerEmail: email,
          label: input.label,
          targetSessionId: input.target_session_id,
          authMode: input.auth_mode,
          preamble: input.preamble ?? null,
          expiresInSeconds: input.expires_in_seconds ?? null,
        });
        reply.code(201);
        return {
          id: issued.grant.id,
          url: buildInboundWebhookUrl(options.publicUrl, issued.grant.id),
          auth_mode: issued.grant.auth_mode,
          secret: issued.secret,
          label: issued.grant.label,
          target_session_id: issued.grant.target_session_id,
          preamble: issued.grant.preamble,
          created_at: issued.grant.created_at.toISOString(),
          expires_at: issued.grant.expires_at?.toISOString() ?? null,
        };
      } catch (error) {
        return sendRouteError(options, request, reply, error);
      }
    });

    instance.get("/api/webhooks/inbound", async (request, reply) => {
      try {
        const email = await requireEmail(options, request);
        const grants = await options.grants.list(email, "inbound_webhook");
        const summaries = await options.requests.summarizeGrants(
          grants.map((grant) => grant.id),
        );
        return grants.map((grant) =>
          inboundWebhookSummary(grant, options.publicUrl, summaries.get(grant.id))
        );
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
        const { id } = grantIdParamsSchema.parse(request.params);
        const { limit } = requestsQuerySchema.parse(request.query ?? {});
        const grant = await options.grants.findOwned(email, id, "inbound_webhook");
        if (grant === null) {
          throw new InboundWebhookRouteError(404, "Inbound webhook not found");
        }
        return { items: await options.requests.listRecentRequests(grant.id, limit) };
      } catch (error) {
        return sendRouteError(options, request, reply, error);
      }
    });

    instance.delete<{ Params: { id: string } }>(
      "/api/webhooks/inbound/:id",
      async (request, reply) => {
        try {
          const email = await requireEmail(options, request);
          const { id } = grantIdParamsSchema.parse(request.params);
          const revoked = await options.grants.revoke(email, id, "inbound_webhook");
          if (revoked === null) {
            throw new InboundWebhookRouteError(404, "Inbound webhook not found");
          }
          return inboundWebhookSummary(revoked, options.publicUrl, undefined);
        } catch (error) {
          return sendRouteError(options, request, reply, error);
        }
      },
    );
  });
}

/** `${publicUrl}/api/hooks/${grantId}` with trailing slashes on the origin collapsed. */
export function buildInboundWebhookUrl(publicUrl: string, grantId: string): string {
  return `${publicUrl.trim().replace(/\/+$/, "")}/api/hooks/${grantId}`;
}

async function requireEmail(
  options: InboundWebhookRouteOptions,
  request: FastifyRequest,
): Promise<string> {
  const email = (await options.currentEmail(request))?.trim().toLowerCase();
  if (!email) throw new InboundWebhookRouteError(401, "Authentication required");
  return email;
}

/**
 * The same access judgment `resolveGrant` makes before serving a webhook: the
 * service caller path with the login email as the access email. A missing
 * `accessEmail` would make the service-token path unrestricted.
 */
async function requireTargetSessionAccess(
  options: InboundWebhookRouteOptions,
  email: string,
  sessionId: string,
): Promise<void> {
  try {
    await options.requireSessionAccess({
      request: SERVICE_CALLER,
      sessionId,
      accessEmail: email,
    });
  } catch (error) {
    // A missing session and a session this user cannot reach answer the same 404.
    if (error instanceof SessionResourceAccessError) {
      throw new InboundWebhookRouteError(404, "Session not found");
    }
    throw error;
  }
}

function inboundWebhookSummary(
  grant: ExternalAccessGrantSummary,
  publicUrl: string,
  recent: ExternalGrantRecentSummary | undefined,
) {
  return {
    id: grant.id,
    label: grant.label,
    target_session_id: grant.target_session_id,
    auth_mode: grant.auth_mode,
    preamble: grant.preamble,
    url: buildInboundWebhookUrl(publicUrl, grant.id),
    created_at: grant.created_at.toISOString(),
    expires_at: grant.expires_at?.toISOString() ?? null,
    revoked_at: grant.revoked_at?.toISOString() ?? null,
    last_used_at: grant.last_used_at?.toISOString() ?? null,
    state: grantState(grant),
    ...(recent === undefined ? {} : { recent }),
  };
}

function grantState(
  grant: ExternalAccessGrantSummary,
): "active" | "expired" | "revoked" {
  if (grant.revoked_at !== null) return "revoked";
  if (grant.expires_at !== null && grant.expires_at.getTime() <= Date.now()) {
    return "expired";
  }
  return "active";
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
