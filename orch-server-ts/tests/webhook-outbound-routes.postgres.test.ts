import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { Webhook } from "standardwebhooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUserAuthorizer } from "../src/auth/auth_routes.js";
import { SERVICE_CALLER } from "../src/auth/service_caller.js";
import { WebhookError, type WebhookPost } from "../src/external_events/webhook_transport.js";
import type { SessionResourceAccessProvider } from "../src/session/session_resource_access.js";
import {
  createFullSchemaPostgresHarness,
  type FullSchemaPostgresHarness,
} from "./board_yjs_postgres_harness.js";
import { publishSubscription } from "../src/webhooks/outbound_publisher.js";
import { registerOutboundWebhookRoutes } from "../src/webhooks/outbound_routes.js";
import { sendNextDueDelivery, type OutboundSenderDependencies } from "../src/webhooks/outbound_sender.js";
import { OutboundWebhookService } from "../src/webhooks/outbound_service.js";

const OWNER = "owner@example.com";
const OTHER = "other@example.com";
const SECRET = `whsec_${Buffer.alloc(32, 6).toString("base64")}`;

let harness: FullSchemaPostgresHarness;
let app: FastifyInstance;
let post: ReturnType<typeof vi.fn<WebhookPost>>;
let authorizeUser: ReturnType<typeof vi.fn<AuthUserAuthorizer>>;
let requireSessionAccess: ReturnType<
  typeof vi.fn<SessionResourceAccessProvider["requireSessionAccess"]>
>;
let service: OutboundWebhookService;
let logLines: string[];

beforeEach(async () => {
  harness = await createFullSchemaPostgresHarness();
  logLines = [];
  post = vi.fn<WebhookPost>(async (_url, body) => {
    const parsed: unknown = JSON.parse(body);
    if (
      parsed !== null && typeof parsed === "object" &&
      (parsed as Record<string, unknown>).type === "verification"
    ) {
      return {
        status: 200,
        body: JSON.stringify({ challenge: (parsed as Record<string, unknown>).challenge }),
        retryAfter: null,
      };
    }
    return { status: 200, body: "", retryAfter: null };
  });
  authorizeUser = vi.fn<AuthUserAuthorizer>(async () => null);
  requireSessionAccess = vi.fn<SessionResourceAccessProvider["requireSessionAccess"]>(
    async () => undefined,
  );
  service = new OutboundWebhookService({
    resolveSql: async () => harness.sql,
    authorizeUser,
    requireSessionAccess,
    post,
  });
  app = Fastify({
    logger: {
      level: "error",
      stream: { write: (line: string) => { logLines.push(line); } },
    },
  });
  registerOutboundWebhookRoutes(app, {
    currentEmail: (request) => request.headers["test-user"] as string | undefined,
    service,
    authorizeUser,
    sessionAccess: { requireSessionAccess },
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await harness.cleanup();
});

function request(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  email: string | null = OWNER,
  payload?: Record<string, unknown>,
) {
  return app.inject({
    method,
    url,
    headers: email === null ? {} : { "test-user": email },
    ...(payload === undefined ? {} : { payload }),
  });
}

async function seedSession(sessionId = "s1", lastEventId = 0) {
  await harness.sql`
    INSERT INTO sessions (session_id, last_event_id) VALUES (${sessionId}, ${lastEventId})
  `;
}

async function seedSubscription(ownerEmail = OWNER, targetSessionId = "s1") {
  return await service.createSubscription({
    ownerEmail,
    label: "receiver",
    targetSessionId,
    url: "https://receiver.example/hook",
    eventTypes: ["session.reply"],
    signingSecret: SECRET,
  });
}

async function insertDelivery(input: {
  subscriptionId: string;
  eventId: number;
  state: "pending" | "delivered" | "dead";
  createdAt?: Date;
  lastError?: string | null;
}): Promise<string> {
  const id = randomUUID();
  const createdAt = input.createdAt ?? new Date();
  await harness.sql`
    INSERT INTO webhook_deliveries (
      id, subscription_id, session_id, event_id, event_type, payload,
      state, attempt_count, next_attempt_at, window_started_at, created_at, last_error
    ) VALUES (
      ${id}, ${input.subscriptionId}, 's1', ${input.eventId}, 'session.reply',
      ${harness.sql.json({} as never)}, ${input.state}, 0,
      ${createdAt}, ${createdAt}, ${createdAt}, ${input.lastError ?? null}
    )
  `;
  return id;
}

async function publishOneEvent(subscriptionId: string): Promise<string> {
  await harness.sql`
    INSERT INTO events (session_id, id, event_type, payload, created_at)
    VALUES ('s1', 1, 'complete', ${harness.sql.json({ type: "complete", result: "done" } as never)}, ${new Date()})
  `;
  await harness.sql`UPDATE sessions SET last_event_id = 1 WHERE session_id = 's1'`;
  expect(await publishSubscription(harness.sql, subscriptionId, new Date())).toEqual({
    inserted: 1,
    cursor: 1,
  });
  const [row] = await harness.sql<Array<{ id: string }>>`
    SELECT id FROM webhook_deliveries WHERE subscription_id = ${subscriptionId}
  `;
  return row!.id;
}

function senderDependencies(): OutboundSenderDependencies {
  return {
    sql: harness.sql,
    post,
    authorizeUser,
    requireSessionAccess,
    now: Date.now,
  };
}

function subscriptionCount(): Promise<number> {
  return harness.sql<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS count FROM webhook_subscriptions
  `.then((rows) => rows[0]!.count);
}

const validCreate = {
  target_session_id: "s1",
  label: "receiver",
  url: "https://receiver.example/hook",
  event_types: ["session.reply"],
};

describe("outbound webhook routes", () => {
  it("creates a subscription after a signed challenge and returns the secret once", async () => {
    await seedSession();

    const response = await request("POST", "/api/webhooks/outbound", OWNER, validCreate);

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.signing_secret).toMatch(/^whsec_/);
    expect(body.subscription).toMatchObject({
      owner_email: OWNER,
      label: "receiver",
      target_session_id: "s1",
      event_types: ["session.reply"],
      active: true,
    });
    expect(body.subscription.signing_secret).toBeUndefined();

    expect(post).toHaveBeenCalledTimes(1);
    const [url, challengeBody, headers] = post.mock.calls[0]!;
    expect(url).toBe("https://receiver.example/hook");
    const challenge = JSON.parse(challengeBody) as { type: string; challenge: string };
    expect(challenge.type).toBe("verification");
    expect(new Webhook(body.signing_secret).verify(challengeBody, headers)).toEqual(challenge);
    expect(authorizeUser).toHaveBeenCalledWith({ email: OWNER });
    expect(requireSessionAccess).toHaveBeenCalledWith({
      request: SERVICE_CALLER,
      sessionId: "s1",
      accessEmail: OWNER,
    });

    const rows = await harness.sql<Array<{ signing_secret: string; cursor_event_id: number }>>`
      SELECT signing_secret, cursor_event_id FROM webhook_subscriptions
      WHERE id = ${body.subscription.id}
    `;
    expect(rows[0]).toEqual({ signing_secret: body.signing_secret, cursor_event_id: 0 });
  });

  it.each([
    [
      "a mismatched challenge echo",
      async () => ({ status: 200, body: JSON.stringify({ challenge: "different" }), retryAfter: null }),
      "verification_failed",
    ],
    [
      "a non-2xx response",
      async () => ({ status: 400, body: "no", retryAfter: null }),
      "verification_failed",
    ],
    [
      "an unsafe callback",
      async () => { throw new WebhookError("unsafe_callback"); },
      "unsafe_callback",
    ],
  ])("rejects registration on %s without creating a row", async (_name, postImpl, reason) => {
    await seedSession();
    post.mockImplementationOnce(postImpl as WebhookPost);

    const response = await request("POST", "/api/webhooks/outbound", OWNER, validCreate);

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: "challenge_failed", reason });
    expect(await subscriptionCount()).toBe(0);
  });

  it.each([
    ["a blank label", { ...validCreate, label: "   " }],
    ["an http url", { ...validCreate, url: "http://receiver.example/hook" }],
    ["an overlong url", { ...validCreate, url: `https://receiver.example/${"a".repeat(2048)}` }],
    ["empty event types", { ...validCreate, event_types: [] }],
    ["an unknown event type", { ...validCreate, event_types: ["session.other"] }],
    ["a duplicate event type", { ...validCreate, event_types: ["session.reply", "session.reply"] }],
    ["an unknown field", { ...validCreate, owner_email: OTHER }],
    ["a blank target session", { ...validCreate, target_session_id: "  " }],
  ])("rejects %s with 422", async (_name, payload) => {
    await seedSession();

    const response = await request("POST", "/api/webhooks/outbound", OWNER, payload);

    expect(response.statusCode).toBe(422);
    expect(await subscriptionCount()).toBe(0);
    expect(post).not.toHaveBeenCalled();
  });

  it("returns 404 when the target session does not exist", async () => {
    const response = await request("POST", "/api/webhooks/outbound", OWNER, {
      ...validCreate,
      target_session_id: "missing",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "session_not_found" });
    expect(post).not.toHaveBeenCalled();
  });

  it("returns 403 when the user is denied or the session access check fails", async () => {
    await seedSession();
    authorizeUser.mockResolvedValueOnce("user_disabled");
    const deniedUser = await request("POST", "/api/webhooks/outbound", OWNER, validCreate);
    expect(deniedUser.statusCode).toBe(403);
    expect(deniedUser.json()).toEqual({ error: "forbidden" });

    requireSessionAccess.mockRejectedValueOnce(new Error("denied"));
    const deniedSession = await request("POST", "/api/webhooks/outbound", OWNER, validCreate);
    expect(deniedSession.statusCode).toBe(403);
    expect(deniedSession.json()).toEqual({ error: "forbidden" });
    expect(post).not.toHaveBeenCalled();
    expect(await subscriptionCount()).toBe(0);
  });

  it("requires a logged-in user on every route", async () => {
    const id = "00000000-0000-0000-0000-000000000000";
    for (const [method, url, payload] of [
      ["POST", "/api/webhooks/outbound", {}],
      ["GET", "/api/webhooks/outbound", undefined],
      ["GET", `/api/webhooks/outbound/${id}/deliveries`, undefined],
      ["POST", `/api/webhooks/outbound/${id}/deliveries/${id}/redeliver`, undefined],
      ["PATCH", `/api/webhooks/outbound/${id}`, { active: false }],
      ["DELETE", `/api/webhooks/outbound/${id}`, undefined],
    ] as const) {
      const response = await request(method, url, null, payload as Record<string, unknown>);
      expect(response.statusCode).toBe(401);
    }
  });

  it("lists own subscriptions with recent failures and never the secret", async () => {
    await seedSession();
    const recent = await seedSubscription();
    const older = await seedSubscription();
    await insertDelivery({ subscriptionId: recent.id, eventId: 1, state: "dead" });
    await insertDelivery({
      subscriptionId: recent.id,
      eventId: 2,
      state: "dead",
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });
    await insertDelivery({ subscriptionId: older.id, eventId: 1, state: "delivered" });

    const response = await request("GET", "/api/webhooks/outbound");

    expect(response.statusCode).toBe(200);
    const { subscriptions } = response.json() as {
      subscriptions: Array<{ id: string; recent_failures: number }>;
    };
    expect(subscriptions.map((subscription) => subscription.id).sort())
      .toEqual([recent.id, older.id].sort());
    expect(subscriptions.find((subscription) => subscription.id === recent.id)?.recent_failures)
      .toBe(1);
    expect(subscriptions.find((subscription) => subscription.id === older.id)?.recent_failures)
      .toBe(0);
    expect(response.body).not.toContain(SECRET);

    const other = await request("GET", "/api/webhooks/outbound", OTHER);
    expect(other.json()).toEqual({ subscriptions: [] });
  });

  it("lists deliveries with the requested state and without payloads", async () => {
    await seedSession();
    const subscription = await seedSubscription();
    const older = new Date(Date.now() - 3_000);
    const newer = new Date(Date.now() - 1_000);
    const deadId = await insertDelivery({
      subscriptionId: subscription.id,
      eventId: 1,
      state: "dead",
      createdAt: older,
      lastError: "http_400",
    });
    const pendingId = await insertDelivery({
      subscriptionId: subscription.id,
      eventId: 2,
      state: "pending",
      createdAt: newer,
    });

    const all = await request("GET", `/api/webhooks/outbound/${subscription.id}/deliveries`);
    expect(all.statusCode).toBe(200);
    const { deliveries } = all.json() as { deliveries: Array<Record<string, unknown>> };
    expect(deliveries.map((delivery) => delivery.id)).toEqual([pendingId, deadId]);
    expect(Object.keys(deliveries[0]!).sort()).toEqual([
      "attempt_count",
      "created_at",
      "delivered_at",
      "event_id",
      "event_type",
      "id",
      "last_error",
      "last_status",
      "next_attempt_at",
      "state",
    ]);

    const limited = await request(
      "GET",
      `/api/webhooks/outbound/${subscription.id}/deliveries?state=dead&limit=1`,
    );
    expect(limited.statusCode).toBe(200);
    expect((limited.json() as { deliveries: Array<{ id: string }> }).deliveries)
      .toEqual([expect.objectContaining({ id: deadId, state: "dead" })]);
    expect(limited.body).not.toContain(SECRET);
  });

  it("returns 404 for other owners' or missing subscriptions on every route", async () => {
    await seedSession();
    const subscription = await seedSubscription();
    const deliveryId = await insertDelivery({
      subscriptionId: subscription.id,
      eventId: 1,
      state: "pending",
    });
    const missing = "00000000-0000-0000-0000-000000000000";
    const routes: Array<[method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: Record<string, unknown>]> = [
      ["GET", `/api/webhooks/outbound/${subscription.id}/deliveries`],
      ["PATCH", `/api/webhooks/outbound/${subscription.id}`, { active: false }],
      ["DELETE", `/api/webhooks/outbound/${subscription.id}`],
      ["POST", `/api/webhooks/outbound/${subscription.id}/deliveries/${deliveryId}/redeliver`],
      ["GET", `/api/webhooks/outbound/${missing}/deliveries`],
      ["PATCH", `/api/webhooks/outbound/${missing}`, { active: false }],
      ["DELETE", `/api/webhooks/outbound/${missing}`],
      ["POST", `/api/webhooks/outbound/${missing}/deliveries/${deliveryId}/redeliver`],
      ["GET", "/api/webhooks/outbound/not-a-uuid/deliveries"],
      ["DELETE", "/api/webhooks/outbound/not-a-uuid"],
    ];

    for (const [method, url, payload] of routes) {
      const response = await request(method, url, OTHER, payload);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "not_found" });
    }
    expect(post).not.toHaveBeenCalled();
    const [row] = await harness.sql<Array<{ active: boolean; state: string }>>`
      SELECT subscription.active, delivery.state
      FROM webhook_subscriptions subscription
      JOIN webhook_deliveries delivery ON delivery.subscription_id = subscription.id
      WHERE subscription.id = ${subscription.id} AND delivery.id = ${deliveryId}
    `;
    expect(row).toEqual({ active: true, state: "pending" });
  });

  it("rejects redelivery of another subscription's delivery", async () => {
    await seedSession();
    const first = await seedSubscription();
    const second = await seedSubscription();
    const deliveryId = await insertDelivery({
      subscriptionId: first.id,
      eventId: 1,
      state: "pending",
    });

    const response = await request(
      "POST",
      `/api/webhooks/outbound/${second.id}/deliveries/${deliveryId}/redeliver`,
    );

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "not_found" });
    expect(post).not.toHaveBeenCalled();
  });

  it("redelivers a dead delivery under the same webhook-id", async () => {
    await seedSession();
    const subscription = await seedSubscription();
    const deliveryId = await publishOneEvent(subscription.id);
    post.mockResolvedValueOnce({ status: 400, body: "", retryAfter: null });
    expect(await sendNextDueDelivery(senderDependencies())).toBe(true);
    const [dead] = await harness.sql<Array<{ state: string }>>`
      SELECT state FROM webhook_deliveries WHERE id = ${deliveryId}
    `;
    expect(dead).toEqual({ state: "dead" });

    const response = await request(
      "POST",
      `/api/webhooks/outbound/${subscription.id}/deliveries/${deliveryId}/redeliver`,
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ outcome: "delivered" });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0]![2]["webhook-id"]).toBe(post.mock.calls[1]![2]["webhook-id"]);
    const [row] = await harness.sql<Array<{ state: string }>>`
      SELECT state FROM webhook_deliveries WHERE id = ${deliveryId}
    `;
    expect(row).toEqual({ state: "delivered" });
  });

  it("returns 409 for redelivery on an inactive subscription without posting", async () => {
    await seedSession();
    const subscription = await seedSubscription();
    const deliveryId = await insertDelivery({
      subscriptionId: subscription.id,
      eventId: 1,
      state: "pending",
    });
    const disabled = await request(
      "PATCH",
      `/api/webhooks/outbound/${subscription.id}`,
      OWNER,
      { active: false },
    );
    expect(disabled.statusCode).toBe(200);

    const response = await request(
      "POST",
      `/api/webhooks/outbound/${subscription.id}/deliveries/${deliveryId}/redeliver`,
    );

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "subscription_inactive" });
    expect(post).not.toHaveBeenCalled();
  });

  it("holds pending deliveries while disabled and closes them when re-enabled", async () => {
    await seedSession();
    const subscription = await seedSubscription();
    const deliveryId = await publishOneEvent(subscription.id);

    const disabled = await request(
      "PATCH",
      `/api/webhooks/outbound/${subscription.id}`,
      OWNER,
      { active: false },
    );
    expect(disabled.statusCode).toBe(200);
    expect((disabled.json() as { subscription: { active: boolean } }).subscription.active)
      .toBe(false);

    expect(await sendNextDueDelivery(senderDependencies())).toBe(false);
    expect(post).not.toHaveBeenCalled();
    const [held] = await harness.sql<Array<{ state: string }>>`
      SELECT state FROM webhook_deliveries WHERE id = ${deliveryId}
    `;
    expect(held).toEqual({ state: "pending" });
    expect(disabled.body).not.toContain(SECRET);

    await harness.sql`UPDATE sessions SET last_event_id = 9 WHERE session_id = 's1'`;
    const enabled = await request(
      "PATCH",
      `/api/webhooks/outbound/${subscription.id}`,
      OWNER,
      { active: true },
    );
    expect(enabled.statusCode).toBe(200);
    expect(enabled.body).not.toContain(SECRET);
    const [closed] = await harness.sql<Array<{ state: string; last_error: string | null }>>`
      SELECT state, last_error FROM webhook_deliveries WHERE id = ${deliveryId}
    `;
    expect(closed).toEqual({ state: "dead", last_error: "disabled_while_pending" });
    const [row] = await harness.sql<Array<{ cursor_event_id: number }>>`
      SELECT cursor_event_id FROM webhook_subscriptions WHERE id = ${subscription.id}
    `;
    expect(row).toEqual({ cursor_event_id: 9 });
    expect(await sendNextDueDelivery(senderDependencies())).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it("answers 503 without leaking the secret when storage fails", async () => {
    const leak = `whsec_leak_${randomUUID()}`;
    const error = Object.assign(new Error(`duplicate key value violates unique constraint ${leak}`), {
      code: "23505",
      constraint_name: "webhook_subscriptions_pkey",
      detail: `Key (signing_secret)=(${leak}) already exists.`,
    });
    vi.spyOn(service, "listSubscriptions").mockRejectedValueOnce(error);

    const response = await request("GET", "/api/webhooks/outbound");

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "unavailable" });
    expect(response.body).not.toContain(leak);
    const logged = logLines.join("\n");
    expect(logged).not.toContain(leak);
    expect(logged).not.toContain(error.message);
    expect(logged).toContain("23505");
    expect(logged).toContain("webhook_subscriptions_pkey");
  });

  it("deletes an own subscription and returns 204", async () => {
    await seedSession();
    const subscription = await seedSubscription();

    const response = await request("DELETE", `/api/webhooks/outbound/${subscription.id}`);

    expect(response.statusCode).toBe(204);
    const [row] = await harness.sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count FROM webhook_subscriptions WHERE id = ${subscription.id}
    `;
    expect(row).toEqual({ count: 0 });
  });
});
