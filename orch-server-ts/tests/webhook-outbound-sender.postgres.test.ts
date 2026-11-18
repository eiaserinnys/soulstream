import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Webhook } from "standardwebhooks";
import { SERVICE_CALLER } from "../src/auth/service_caller.js";
import type { WebhookPost } from "../src/external_events/webhook_transport.js";
import { createFullSchemaPostgresHarness, type FullSchemaPostgresHarness } from "./board_yjs_postgres_harness.js";
import { publishSubscription } from "../src/webhooks/outbound_publisher.js";
import { sendNextDueDelivery, type OutboundSenderDependencies } from "../src/webhooks/outbound_sender.js";
import { OutboundWebhookService } from "../src/webhooks/outbound_service.js";

const OWNER = "owner@example.com";
const SECRET = `whsec_${Buffer.alloc(32, 4).toString("base64")}`;
const T0 = Date.parse("2026-11-18T00:00:00.000Z");

let harness: FullSchemaPostgresHarness;
let clock: number;
let post: ReturnType<typeof vi.fn<WebhookPost>>;

beforeEach(async () => {
  harness = await createFullSchemaPostgresHarness();
  clock = T0;
  post = vi.fn<WebhookPost>(async () => ({ status: 200, body: "", retryAfter: null }));
});

afterEach(async () => {
  await harness.cleanup();
});

function now() {
  return clock;
}

function makeService(overrides: { requireSessionAccess?: OutboundSenderDependencies["requireSessionAccess"] } = {}) {
  return new OutboundWebhookService({
    resolveSql: async () => harness.sql,
    authorizeUser: () => null,
    requireSessionAccess: overrides.requireSessionAccess ?? (async () => undefined),
    post,
    now,
  });
}

function makeSender(
  overrides: Partial<OutboundSenderDependencies> = {},
): OutboundSenderDependencies {
  return {
    sql: harness.sql,
    post,
    authorizeUser: () => null,
    requireSessionAccess: async () => undefined,
    now,
    ...overrides,
  };
}

async function seedPendingDelivery(): Promise<{ subscriptionId: string; deliveryId: string }> {
  await harness.sql`INSERT INTO sessions (session_id, last_event_id) VALUES ('s1', 0)`;
  const service = makeService();
  const subscription = await service.createSubscription({
    ownerEmail: OWNER,
    label: "receiver",
    targetSessionId: "s1",
    url: "https://receiver.example/hook",
    eventTypes: ["session.reply"],
    signingSecret: SECRET,
  });
  await harness.sql`
    INSERT INTO events (session_id, id, event_type, payload, created_at)
    VALUES ('s1', 1, 'complete', ${harness.sql.json({ type: "complete", result: "done" } as never)}, ${new Date(T0)})
  `;
  await harness.sql`UPDATE sessions SET last_event_id = 1 WHERE session_id = 's1'`;
  expect(await publishSubscription(harness.sql, subscription.id, new Date(T0))).toEqual({
    inserted: 1,
    cursor: 1,
  });
  const [row] = await harness.sql<Array<{ id: string }>>`
    SELECT id FROM webhook_deliveries WHERE subscription_id = ${subscription.id}
  `;
  await setDue(row!.id);
  return { subscriptionId: subscription.id, deliveryId: row!.id };
}

async function setDue(deliveryId: string) {
  await harness.sql`UPDATE webhook_deliveries SET next_attempt_at = ${new Date(clock)} WHERE id = ${deliveryId}`;
}

async function deliveryRow(deliveryId: string) {
  const [row] = await harness.sql<Array<{
    state: string;
    attempt_count: number;
    next_attempt_at: Date;
    last_status: number | null;
    last_error: string | null;
    delivered_at: Date | null;
    payload: Record<string, unknown>;
  }>>`
    SELECT state, attempt_count, next_attempt_at, last_status, last_error, delivered_at, payload
    FROM webhook_deliveries WHERE id = ${deliveryId}
  `;
  return row!;
}

async function subscriptionRow(subscriptionId: string) {
  const [row] = await harness.sql<Array<{
    active: boolean;
    disabled_reason: string | null;
    consecutive_failures: number;
    cursor_event_id: number;
  }>>`
    SELECT active, disabled_reason, consecutive_failures, cursor_event_id
    FROM webhook_subscriptions WHERE id = ${subscriptionId}
  `;
  return row!;
}

describe("outbound webhook sender", () => {
  it("records a 2xx as delivered with headers verifiable by the subscription secret", async () => {
    const { deliveryId } = await seedPendingDelivery();
    clock = Date.now();
    await setDue(deliveryId);

    expect(await sendNextDueDelivery(makeSender())).toBe(true);

    expect(post).toHaveBeenCalledTimes(1);
    const [url, body, headers] = post.mock.calls[0]!;
    expect(url).toBe("https://receiver.example/hook");
    const row = await deliveryRow(deliveryId);
    expect(row.state).toBe("delivered");
    expect(row.delivered_at).not.toBeNull();
    expect(row.last_status).toBe(200);
    expect(new Webhook(SECRET).verify(body, headers)).toEqual(row.payload);
  });

  it("keeps the same webhook-id when a 500 is retried", async () => {
    const { deliveryId } = await seedPendingDelivery();
    post.mockResolvedValueOnce({ status: 500, body: "", retryAfter: null });
    post.mockResolvedValueOnce({ status: 200, body: "", retryAfter: null });

    expect(await sendNextDueDelivery(makeSender())).toBe(true);
    const failed = await deliveryRow(deliveryId);
    expect(failed.state).toBe("pending");
    expect(failed.attempt_count).toBe(1);
    expect(failed.last_status).toBe(500);
    expect(failed.last_error).toBe("http_500");
    expect(failed.next_attempt_at.getTime() - clock).toBe(10_000);

    clock = failed.next_attempt_at.getTime();
    expect(await sendNextDueDelivery(makeSender())).toBe(true);

    const [first, second] = post.mock.calls;
    expect(first![2]["webhook-id"]).toBe(second![2]["webhook-id"]);
    expect((await deliveryRow(deliveryId)).state).toBe("delivered");
  });

  it("honors Retry-After: 120 on 429", async () => {
    const { deliveryId } = await seedPendingDelivery();
    post.mockResolvedValueOnce({ status: 429, body: "", retryAfter: "120" });

    expect(await sendNextDueDelivery(makeSender())).toBe(true);

    const row = await deliveryRow(deliveryId);
    expect(row.state).toBe("pending");
    expect(row.attempt_count).toBe(1);
    expect(row.last_status).toBe(429);
    expect(row.next_attempt_at.getTime()).toBe(clock + 120_000);
  });

  it("dies on the 16th transient failure", async () => {
    const { subscriptionId, deliveryId } = await seedPendingDelivery();
    post.mockResolvedValue({ status: 500, body: "", retryAfter: null });

    for (let attempt = 1; attempt <= 16; attempt += 1) {
      await setDue(deliveryId);
      expect(await sendNextDueDelivery(makeSender())).toBe(true);
    }

    const row = await deliveryRow(deliveryId);
    expect(row.state).toBe("dead");
    expect(row.attempt_count).toBe(16);
    expect((await subscriptionRow(subscriptionId)).consecutive_failures).toBe(1);
  });

  it("dies immediately on a 400", async () => {
    const { deliveryId } = await seedPendingDelivery();
    post.mockResolvedValueOnce({ status: 400, body: "bad request", retryAfter: null });

    expect(await sendNextDueDelivery(makeSender())).toBe(true);

    const row = await deliveryRow(deliveryId);
    expect(row.state).toBe("dead");
    expect(row.last_status).toBe(400);
    expect(row.last_error).toBe("http_400");
    expect(JSON.stringify(row)).not.toContain("bad request");
  });

  it("dies and disables the subscription on a 410", async () => {
    const { subscriptionId, deliveryId } = await seedPendingDelivery();
    post.mockResolvedValueOnce({ status: 410, body: "", retryAfter: null });

    expect(await sendNextDueDelivery(makeSender())).toBe(true);

    expect((await deliveryRow(deliveryId)).state).toBe("dead");
    expect(await subscriptionRow(subscriptionId)).toMatchObject({
      active: false,
      disabled_reason: "gone",
    });
  });

  it("never posts pending deliveries of a disabled subscription", async () => {
    const { subscriptionId, deliveryId } = await seedPendingDelivery();
    await makeService().setActive(OWNER, subscriptionId, false);

    expect(await sendNextDueDelivery(makeSender())).toBe(false);
    expect(post).not.toHaveBeenCalled();
    expect((await deliveryRow(deliveryId)).state).toBe("pending");
  });

  it("never posts when the issuer lost access", async () => {
    const { deliveryId } = await seedPendingDelivery();
    const sender = makeSender({
      requireSessionAccess: async () => {
        throw new Error("access revoked");
      },
    });

    expect(await sendNextDueDelivery(sender)).toBe(true);
    expect(post).not.toHaveBeenCalled();
    const row = await deliveryRow(deliveryId);
    expect(row.state).toBe("dead");
    expect(row.last_error).toBe("access_revoked");
  });

  it("dies with access_revoked when issuer authorization returns a denial", async () => {
    const { deliveryId } = await seedPendingDelivery();
    const sender = makeSender({ authorizeUser: () => "user_disabled" });

    expect(await sendNextDueDelivery(sender)).toBe(true);
    expect(post).not.toHaveBeenCalled();
    const row = await deliveryRow(deliveryId);
    expect(row.state).toBe("dead");
    expect(row.last_error).toBe("access_revoked");
  });

  it("checks the issuer and the target session through the service caller", async () => {
    const { deliveryId } = await seedPendingDelivery();
    const authorizeUser = vi.fn(() => null);
    const requireSessionAccess = vi.fn(async () => undefined);
    const sender = makeSender({ authorizeUser, requireSessionAccess });

    expect(await sendNextDueDelivery(sender)).toBe(true);

    expect(authorizeUser).toHaveBeenCalledWith({ email: OWNER });
    expect(requireSessionAccess).toHaveBeenCalledWith({
      request: SERVICE_CALLER,
      sessionId: "s1",
      accessEmail: OWNER,
    });
    expect((await deliveryRow(deliveryId)).state).toBe("delivered");
  });

  it("never posts when the target session was deleted", async () => {
    const { deliveryId } = await seedPendingDelivery();
    await harness.sql`DELETE FROM sessions WHERE session_id = 's1'`;

    expect(await sendNextDueDelivery(makeSender())).toBe(true);
    expect(post).not.toHaveBeenCalled();
    const row = await deliveryRow(deliveryId);
    expect(row.state).toBe("dead");
    expect(row.last_error).toBe("target_missing");
  });

  it("closes pending deliveries and moves the cursor when re-enabled", async () => {
    const { subscriptionId, deliveryId } = await seedPendingDelivery();
    const service = makeService();
    await service.setActive(OWNER, subscriptionId, false);
    await harness.sql`UPDATE sessions SET last_event_id = 9 WHERE session_id = 's1'`;

    await service.setActive(OWNER, subscriptionId, true);

    const delivery = await deliveryRow(deliveryId);
    expect(delivery.state).toBe("dead");
    expect(delivery.last_error).toBe("disabled_while_pending");
    expect(await subscriptionRow(subscriptionId)).toMatchObject({
      active: true,
      disabled_reason: null,
      consecutive_failures: 0,
      cursor_event_id: 9,
    });
  });

  it("manual redelivery keeps the same webhook-id", async () => {
    const { subscriptionId, deliveryId } = await seedPendingDelivery();
    const service = makeService();

    expect(await sendNextDueDelivery(makeSender())).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);

    clock += 1_000;
    const result = await service.redeliver(OWNER, subscriptionId, deliveryId);

    expect(result).toMatchObject({ ok: true, outcome: "delivered" });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0]![2]["webhook-id"]).toBe(post.mock.calls[1]![2]["webhook-id"]);
    expect((await deliveryRow(deliveryId)).state).toBe("delivered");
  });

  it("rejects manual redelivery when the subscription is inactive", async () => {
    const { subscriptionId, deliveryId } = await seedPendingDelivery();
    const service = makeService();
    await service.setActive(OWNER, subscriptionId, false);

    expect(await service.redeliver(OWNER, subscriptionId, deliveryId)).toEqual({
      ok: false,
      reason: "subscription_inactive",
    });
    expect(post).not.toHaveBeenCalled();
  });

  it("disables the subscription when one more dead reaches twenty consecutive failures", async () => {
    const { subscriptionId, deliveryId } = await seedPendingDelivery();
    await harness.sql`
      UPDATE webhook_subscriptions SET consecutive_failures = 19 WHERE id = ${subscriptionId}
    `;
    post.mockResolvedValueOnce({ status: 400, body: "", retryAfter: null });

    expect(await sendNextDueDelivery(makeSender())).toBe(true);

    expect((await deliveryRow(deliveryId)).state).toBe("dead");
    expect(await subscriptionRow(subscriptionId)).toMatchObject({
      active: false,
      disabled_reason: "consecutive_failures",
      consecutive_failures: 20,
    });
  });
});
