import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  createOutboundWebhook,
  deleteOutboundWebhook,
  listOutboundWebhookDeliveries,
  listOutboundWebhooks,
  normalizeWebhookOwnerEmail,
  outboundWebhookActiveSchema,
  outboundWebhookCreateSchema,
  outboundWebhookDeliveryQuerySchema,
  outboundWebhookId,
  redeliverOutboundWebhook,
  setOutboundWebhookActive,
  type OutboundWebhookManagement,
} from "./webhook_management.js";

/** The commands live in `webhook_management.ts`, shared with the MCP webhook tools. */
export type OutboundWebhookRouteOptions = OutboundWebhookManagement & {
  currentEmail: (
    request: FastifyRequest,
  ) => Promise<string | null | undefined> | string | null | undefined;
};

export const outboundWebhookRouteAuthRequirements = {
  "POST /api/webhooks/outbound": true,
  "GET /api/webhooks/outbound": true,
  "GET /api/webhooks/outbound/:id/deliveries": true,
  "POST /api/webhooks/outbound/:id/deliveries/:delivery_id/redeliver": true,
  "PATCH /api/webhooks/outbound/:id": true,
  "DELETE /api/webhooks/outbound/:id": true,
} as const;

const OUTBOUND_WEBHOOK_BODY_LIMIT = 16 * 1024;

export function registerOutboundWebhookRoutes(
  app: FastifyInstance,
  options: OutboundWebhookRouteOptions,
): void {
  app.post(
    "/api/webhooks/outbound",
    { bodyLimit: OUTBOUND_WEBHOOK_BODY_LIMIT },
    async (request, reply) => await handle(request, reply, options, async (email) => {
      const input = outboundWebhookCreateSchema.parse(request.body ?? {});
      const created = await createOutboundWebhook(options, email, input);
      if (created.ok) return reply.code(201).send(created.value);
      switch (created.code) {
        case "session_not_found":
          return reply.code(404).send({ error: "session_not_found" });
        case "challenge_failed":
          return reply.code(422).send({ error: "challenge_failed", reason: created.reason });
        default:
          return reply.code(403).send({ error: "forbidden" });
      }
    }),
  );

  app.get(
    "/api/webhooks/outbound",
    async (request, reply) => await handle(request, reply, options, async (email) => {
      return await listOutboundWebhooks(options, email);
    }),
  );

  app.get(
    "/api/webhooks/outbound/:id/deliveries",
    async (request, reply) => await handle(request, reply, options, async (email) => {
      const subscriptionId = outboundWebhookId((request.params as { id: string }).id);
      if (subscriptionId === null) return reply.code(404).send({ error: "not_found" });
      const query = outboundWebhookDeliveryQuerySchema.parse(request.query ?? {});
      const listed = await listOutboundWebhookDeliveries(options, email, subscriptionId, query);
      return listed.ok ? listed.value : reply.code(404).send({ error: "not_found" });
    }),
  );

  app.post(
    "/api/webhooks/outbound/:id/deliveries/:delivery_id/redeliver",
    async (request, reply) => await handle(request, reply, options, async (email) => {
      const params = request.params as { id: string; delivery_id: string };
      const result = await redeliverOutboundWebhook(options, email, params.id, params.delivery_id);
      if (result.ok) return result.value;
      return result.code === "subscription_inactive"
        ? reply.code(409).send({ error: "subscription_inactive" })
        : reply.code(404).send({ error: "not_found" });
    }),
  );

  app.patch(
    "/api/webhooks/outbound/:id",
    { bodyLimit: OUTBOUND_WEBHOOK_BODY_LIMIT },
    async (request, reply) => await handle(request, reply, options, async (email) => {
      const subscriptionId = outboundWebhookId((request.params as { id: string }).id);
      if (subscriptionId === null) return reply.code(404).send({ error: "not_found" });
      const input = outboundWebhookActiveSchema.parse(request.body ?? {});
      const updated = await setOutboundWebhookActive(options, email, subscriptionId, input.active);
      return updated.ok ? updated.value : reply.code(404).send({ error: "not_found" });
    }),
  );

  app.delete(
    "/api/webhooks/outbound/:id",
    async (request, reply) => await handle(request, reply, options, async (email) => {
      const deleted = await deleteOutboundWebhook(
        options,
        email,
        (request.params as { id: string }).id,
      );
      return deleted.ok
        ? reply.code(204).send()
        : reply.code(404).send({ error: "not_found" });
    }),
  );
}

async function handle(
  request: FastifyRequest,
  reply: FastifyReply,
  options: OutboundWebhookRouteOptions,
  work: (email: string) => Promise<unknown>,
): Promise<unknown> {
  const email = normalizeWebhookOwnerEmail(await options.currentEmail(request));
  if (!email) return reply.code(401).send({ detail: "Authentication required" });
  try {
    return await work(email);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return reply.code(422).send({ detail: "Invalid outbound webhook request" });
    }
    logDatabaseFailure(request, error);
    return reply.code(503).send({ error: "unavailable" });
  }
}

/**
 * Database failures can carry whole rows (including the signing secret) in
 * their message and detail, so only the SQLSTATE code and constraint name
 * reach the log.
 */
function logDatabaseFailure(request: FastifyRequest, error: unknown): void {
  const record = error !== null && typeof error === "object"
    ? error as Record<string, unknown>
    : {};
  const sqlState = typeof record.code === "string" ? record.code : undefined;
  const constraintName = typeof record.constraint_name === "string"
    ? record.constraint_name
    : typeof record.constraint === "string" ? record.constraint : undefined;
  request.log.error(
    {
      ...(sqlState === undefined ? {} : { sqlState }),
      ...(constraintName === undefined ? {} : { constraintName }),
    },
    "outbound webhook request failed",
  );
}
