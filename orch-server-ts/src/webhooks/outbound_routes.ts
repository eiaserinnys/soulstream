import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AuthUserAuthorizer } from "../auth/auth_routes.js";
import { SERVICE_CALLER } from "../auth/service_caller.js";
import { WebhookError } from "../external_events/webhook_transport.js";
import type { SessionResourceAccessProvider } from "../session/session_resource_access.js";
import {
  OUTBOUND_EVENT_TYPES,
  type WebhookDeliveryRow,
} from "./outbound_types.js";
import type { OutboundWebhookService } from "./outbound_service.js";

export type OutboundWebhookRouteOptions = {
  currentEmail: (
    request: FastifyRequest,
  ) => Promise<string | null | undefined> | string | null | undefined;
  service: OutboundWebhookService;
  authorizeUser: AuthUserAuthorizer;
  sessionAccess: Pick<SessionResourceAccessProvider, "requireSessionAccess">;
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
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const eventTypeSchema = z.enum(OUTBOUND_EVENT_TYPES);
const createSubscriptionSchema = z
  .object({
    target_session_id: z.string().trim().min(1),
    label: z.string().trim().min(1).max(200),
    url: z.string().trim().max(2048).refine(isHttpsUrl),
    event_types: z
      .array(eventTypeSchema)
      .min(1)
      .refine((types) => new Set(types).size === types.length),
  })
  .strict();
const updateSubscriptionSchema = z.object({ active: z.boolean() }).strict();
const deliveryQuerySchema = z.object({
  state: z.enum(["pending", "delivered", "dead"]).optional(),
  limit: z.coerce.number().int().positive().optional(),
});

export function registerOutboundWebhookRoutes(
  app: FastifyInstance,
  options: OutboundWebhookRouteOptions,
): void {
  app.post(
    "/api/webhooks/outbound",
    { bodyLimit: OUTBOUND_WEBHOOK_BODY_LIMIT },
    async (request, reply) => await handle(request, reply, options, async (email) => {
      const input = createSubscriptionSchema.parse(request.body ?? {});
      if (!(await options.service.sessionExists(input.target_session_id))) {
        return reply.code(404).send({ error: "session_not_found" });
      }
      if (!(await issuerCanAccessSession(options, email, input.target_session_id))) {
        return reply.code(403).send({ error: "forbidden" });
      }
      const signingSecret = options.service.generateSigningSecret();
      try {
        await options.service.verifyChallenge(input.url, signingSecret);
      } catch (error) {
        return reply.code(422).send({
          error: "challenge_failed",
          reason: error instanceof WebhookError ? error.reason : "verification_failed",
        });
      }
      const subscription = await options.service.createSubscription({
        ownerEmail: email,
        label: input.label,
        targetSessionId: input.target_session_id,
        url: input.url,
        eventTypes: input.event_types,
        signingSecret,
      });
      return reply.code(201).send({ subscription, signing_secret: signingSecret });
    }),
  );

  app.get(
    "/api/webhooks/outbound",
    async (request, reply) => await handle(request, reply, options, async (email) => {
      return { subscriptions: await options.service.listSubscriptions(email) };
    }),
  );

  app.get(
    "/api/webhooks/outbound/:id/deliveries",
    async (request, reply) => await handle(request, reply, options, async (email) => {
      const subscriptionId = routeId((request.params as { id: string }).id);
      if (subscriptionId === null) return reply.code(404).send({ error: "not_found" });
      const query = deliveryQuerySchema.parse(request.query ?? {});
      if (await options.service.getSubscription(email, subscriptionId) === null) {
        return reply.code(404).send({ error: "not_found" });
      }
      const deliveries = await options.service.listDeliveries(email, subscriptionId, {
        ...(query.state === undefined ? {} : { state: query.state }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      });
      return { deliveries: deliveries.map(deliveryView) };
    }),
  );

  app.post(
    "/api/webhooks/outbound/:id/deliveries/:delivery_id/redeliver",
    async (request, reply) => await handle(request, reply, options, async (email) => {
      const params = request.params as { id: string; delivery_id: string };
      const subscriptionId = routeId(params.id);
      const deliveryId = routeId(params.delivery_id);
      if (subscriptionId === null || deliveryId === null) {
        return reply.code(404).send({ error: "not_found" });
      }
      const result = await options.service.redeliver(email, subscriptionId, deliveryId);
      if (!result.ok) {
        return result.reason === "subscription_inactive"
          ? reply.code(409).send({ error: "subscription_inactive" })
          : reply.code(404).send({ error: "not_found" });
      }
      return { outcome: result.outcome };
    }),
  );

  app.patch(
    "/api/webhooks/outbound/:id",
    { bodyLimit: OUTBOUND_WEBHOOK_BODY_LIMIT },
    async (request, reply) => await handle(request, reply, options, async (email) => {
      const subscriptionId = routeId((request.params as { id: string }).id);
      if (subscriptionId === null) return reply.code(404).send({ error: "not_found" });
      const input = updateSubscriptionSchema.parse(request.body ?? {});
      const subscription = await options.service.setActive(email, subscriptionId, input.active);
      return subscription === null
        ? reply.code(404).send({ error: "not_found" })
        : { subscription };
    }),
  );

  app.delete(
    "/api/webhooks/outbound/:id",
    async (request, reply) => await handle(request, reply, options, async (email) => {
      const subscriptionId = routeId((request.params as { id: string }).id);
      if (subscriptionId === null) return reply.code(404).send({ error: "not_found" });
      if (!(await options.service.deleteSubscription(email, subscriptionId))) {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.code(204).send();
    }),
  );
}

async function handle(
  request: FastifyRequest,
  reply: FastifyReply,
  options: OutboundWebhookRouteOptions,
  work: (email: string) => Promise<unknown>,
): Promise<unknown> {
  const email = (await options.currentEmail(request))?.trim().toLowerCase();
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

/** Same access judgment as the sender: the user is allowed and still reaches the session. */
async function issuerCanAccessSession(
  options: OutboundWebhookRouteOptions,
  email: string,
  sessionId: string,
): Promise<boolean> {
  try {
    if (await options.authorizeUser({ email })) return false;
    await options.sessionAccess.requireSessionAccess({
      request: SERVICE_CALLER,
      sessionId,
      accessEmail: email,
    });
    return true;
  } catch {
    return false;
  }
}

function routeId(value: string): string | null {
  return UUID_PATTERN.test(value) ? value : null;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function deliveryView(row: WebhookDeliveryRow) {
  return {
    id: row.id,
    event_id: row.event_id,
    event_type: row.event_type,
    state: row.state,
    attempt_count: row.attempt_count,
    next_attempt_at: row.next_attempt_at,
    last_status: row.last_status,
    last_error: row.last_error,
    created_at: row.created_at,
    delivered_at: row.delivered_at,
  };
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
