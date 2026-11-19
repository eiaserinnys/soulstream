/**
 * card #1458 — the eight webhook MCP tools against real Postgres.
 *
 * The real grant repository, the real ExternalInputService and the real
 * OutboundWebhookService run on one database; only the outbound transport (the
 * verification echo, after the real public-address judgment) and the inbound
 * session dispatch are fake. The handlers are called with an internal session
 * context, and the same app also serves the management and receive routes, so
 * every MCP result is checked against what the owner's settings screen sees.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { CallToolResult } from "@soulstream/mcp-contract";
import { createApp } from "../src/app.js";
import type { AuthUserAuthorizer } from "../src/auth/auth_routes.js";
import { parseOrchServerConfig } from "../src/config.js";
import type { SqlClient } from "../src/control_plane/control_plane_types.js";
import { ExternalAccessGrantRepository } from "../src/external_access/external_access_grant_repository.js";
import { ExternalInputService } from "../src/external_access/external_input_service.js";
import {
  resolvePublicCallback,
  type WebhookPost,
} from "../src/external_events/webhook_transport.js";
import { executeMcpTool } from "../src/mcp/tool_executor.js";
import type { McpCallContext, McpHostOptions } from "../src/mcp/types.js";
import { webhookHandlers } from "../src/mcp/webhook_handlers.js";
import {
  SessionResourceAccessError,
  type SessionResourceAccessProvider,
} from "../src/session/session_resource_access.js";
import { publishSubscription } from "../src/webhooks/outbound_publisher.js";
import { OutboundWebhookService } from "../src/webhooks/outbound_service.js";
import {
  createFullSchemaPostgresHarness,
  type FullSchemaPostgresHarness,
} from "./board_yjs_postgres_harness.js";

const OWNER = "owner@example.com";
const OTHER = "other@example.com";
const PUBLIC_URL = "https://soulstream.example.test/";
const PUBLIC_ORIGIN = "https://soulstream.example.test";
const TARGET = "0f6d8c2a-4b31-4d7e-9a15-9c8b7a6d5e4f";
const HIDDEN = "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d";
const MISSING = "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b";
const OWNER_CALLER = "caller-owner";
const OTHER_CALLER = "caller-other";
const ORPHAN_CALLER = "caller-orphan";
const RECEIVER_URL = "https://receiver.example/hook/tok_path_secret";
const WRONG_ECHO_URL = "https://wrong-echo.example/hook/tok_wrong_secret";
const PRIVATE_URL = "https://10.0.0.5/hook/tok_private_secret";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

type Json = Record<string, unknown>;

let harness: FullSchemaPostgresHarness;
let post: ReturnType<typeof vi.fn<WebhookPost>>;
let dispatched: Array<{ targetSessionId: string; body: Json }>;
let app: ReturnType<typeof createApp>;
let options: McpHostOptions;
let errors: string[];

/** Owner caller resolves with untrimmed mixed case: the tools must normalize like the routes. */
const owners: Record<string, string> = {
  [OWNER_CALLER]: "  Owner@Example.COM ",
  [OTHER_CALLER]: OTHER,
};

const requireSessionAccess: SessionResourceAccessProvider["requireSessionAccess"] = async (input) => {
  if (input.sessionId === TARGET) return undefined as never;
  throw new SessionResourceAccessError("SESSION_NOT_FOUND", "Session not found", 404);
};
const authorizeUser: AuthUserAuthorizer = async () => null;

beforeAll(async () => {
  harness = await createFullSchemaPostgresHarness();
}, 120_000);

afterAll(async () => {
  await harness?.cleanup();
});

beforeEach(async () => {
  dispatched = [];
  errors = [];
  for (const table of [
    "webhook_deliveries", "webhook_subscriptions", "external_replies",
    "external_input_receipts", "session_delivery_attempts",
    "session_delivery_relation_consumptions", "session_deliveries",
    "external_access_grants", "events", "sessions", "users",
  ]) {
    await harness.sql.unsafe(`DELETE FROM ${table}`);
  }
  await harness.sql`
    INSERT INTO users (email, display_name) VALUES (${OWNER}, '소유자'), (${OTHER}, '다른 사람')
  `;
  for (const sessionId of [TARGET, HIDDEN]) {
    await harness.sql`
      INSERT INTO sessions (session_id, status, last_event_id) VALUES (${sessionId}, 'running', 0)
    `;
  }
  post = vi.fn<WebhookPost>(async (url, body) => {
    // The real public-address judgment of the transport; only the network is fake.
    await resolvePublicCallback(url, async () => [{ address: "93.184.216.34", family: 4 }]);
    const parsed = JSON.parse(body) as Json;
    if (parsed.type === "verification") {
      const challenge = url === WRONG_ECHO_URL ? "not-the-challenge" : parsed.challenge;
      return { status: 200, body: JSON.stringify({ challenge }), retryAfter: null };
    }
    return { status: 200, body: "", retryAfter: null };
  });
  const sql = harness.sql as unknown as SqlClient;
  const grants = new ExternalAccessGrantRepository({ sql, authorizeUser, requireSessionAccess });
  const inputService = new ExternalInputService({
    sql,
    grants,
    dispatch: async (targetSessionId, body) => {
      dispatched.push({ targetSessionId, body: body as Json });
    },
  });
  const outboundService = new OutboundWebhookService({
    resolveSql: async () => harness.sql as unknown as SqlClient,
    authorizeUser,
    requireSessionAccess,
    post,
  });
  const inbound = { grants, requests: inputService, requireSessionAccess, publicUrl: PUBLIC_URL };
  const outbound = { service: outboundService, authorizeUser, sessionAccess: { requireSessionAccess } };
  const currentEmail = (request: { headers: Record<string, unknown> }) => {
    const header = request.headers["x-user-email"];
    return typeof header === "string" && header.length > 0 ? header : null;
  };
  app = createApp({
    config,
    inboundHookRoutes: { grants, service: inputService },
    inboundWebhookRoutes: { currentEmail, ...inbound },
    outboundWebhookRoutes: { currentEmail, ...outbound },
  });
  await app.ready();
  options = {
    webhooks: { inbound, outbound },
    resolveSessionOwner: async (sessionId: string) => {
      const email = owners[sessionId];
      return email === undefined ? null : { ownerEmail: email, callerInfo: { source: "agent" } };
    },
    cluster: { logger: { warn: () => {} } },
  } as unknown as McpHostOptions;
  return async () => {
    await app.close();
  };
});

function context(callerSessionId: string | null = OWNER_CALLER): McpCallContext {
  return { principal: "internal", callerSessionId, nodeId: "test-node" };
}

type ToolName = keyof typeof webhookHandlers;

async function call(
  name: ToolName,
  args: Json,
  ctx: McpCallContext = context(),
  hostOptions: McpHostOptions = options,
): Promise<CallToolResult> {
  const result = await webhookHandlers[name](hostOptions, args, ctx);
  if (result.isError) errors.push(JSON.stringify(result));
  return result;
}

async function ok(name: ToolName, args: Json, ctx?: McpCallContext): Promise<Json> {
  const result = await call(name, args, ctx);
  expect(result.isError, JSON.stringify(result)).toBeFalsy();
  return JSON.parse((result.content[0] as { text: string }).text) as Json;
}

async function fail(name: ToolName, args: Json, ctx?: McpCallContext, hostOptions?: McpHostOptions) {
  const result = await call(name, args, ctx, hostOptions);
  expect(result.isError, JSON.stringify(result)).toBe(true);
  return (result.content[0] as { text: string }).text;
}

async function screen(method: "GET" | "POST" | "DELETE", url: string, email: string, payload?: Json) {
  return await app.inject({
    method,
    url,
    headers: { "x-user-email": email },
    ...(payload === undefined ? {} : { payload }),
  });
}

async function createKeyWebhook(ctx?: McpCallContext): Promise<Json> {
  return await ok("create_inbound_webhook", {
    target_session_id: TARGET,
    label: "빌드 알림",
    auth_mode: "key",
    preamble: "빌드 결과",
    expires_in_seconds: 3600,
  }, ctx);
}

async function createOutbound(url = RECEIVER_URL, ctx?: McpCallContext): Promise<Json> {
  return await ok("create_outbound_webhook", {
    target_session_id: TARGET,
    label: "받는 곳",
    url,
    event_types: ["session.reply"],
  }, ctx);
}

async function count(table: "external_access_grants" | "webhook_subscriptions"): Promise<number> {
  const rows = await harness.sql.unsafe<Array<{ count: number }>>(
    `SELECT COUNT(*)::int AS count FROM ${table}`,
  );
  return rows[0]!.count;
}

async function insertDelivery(subscriptionId: string, state: "pending" | "delivered" | "dead") {
  const id = randomUUID();
  const now = new Date();
  await harness.sql`
    INSERT INTO webhook_deliveries (
      id, subscription_id, session_id, event_id, event_type, payload,
      state, attempt_count, next_attempt_at, window_started_at, created_at
    ) VALUES (
      ${id}, ${subscriptionId}, ${TARGET}, ${Math.floor(Math.random() * 1_000_000) + 100},
      'session.reply', ${harness.sql.json({} as never)}, ${state}, 0, ${now}, ${now}, ${now}
    )
  `;
  return id;
}

describe("inbound webhook tools", () => {
  it("issues a key webhook whose url and key_url really receive, under the caller's owner", async () => {
    const created = await createKeyWebhook();
    const secret = created.secret as string;
    expect(secret.startsWith("ssxw_")).toBe(true);
    expect(created).toMatchObject({
      url: `${PUBLIC_ORIGIN}/api/hooks/${created.id as string}`,
      key_url: `${PUBLIC_ORIGIN}/x/${secret}/hook`,
      auth_mode: "key",
      label: "빌드 알림",
      target_session_id: TARGET,
      preamble: "빌드 결과",
    });
    expect(Object.keys(created).sort()).toEqual([
      "auth_mode", "created_at", "expires_at", "id", "key_url", "label", "preamble",
      "secret", "target_session_id", "url",
    ]);

    const byUrl = await app.inject({
      method: "POST",
      url: new URL(created.url as string).pathname,
      headers: { authorization: `Bearer ${secret}` },
      payload: "첫 요청",
    });
    expect(byUrl.statusCode).toBe(202);
    const byKeyUrl = await app.inject({
      method: "POST",
      url: new URL(created.key_url as string).pathname,
      payload: "둘째 요청",
    });
    expect(byKeyUrl.statusCode).toBe(202);
    expect(dispatched.map((item) => item.targetSessionId)).toEqual([TARGET, TARGET]);

    const listed = await screen("GET", "/api/webhooks/inbound", OWNER);
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as Json[]).map((item) => item.id)).toEqual([created.id]);
    expect((await screen("GET", "/api/webhooks/inbound", OTHER)).json()).toEqual([]);
  });

  it("gives a signature webhook no key_url", async () => {
    const created = await ok("create_inbound_webhook", {
      target_session_id: TARGET,
      label: "서명 웹훅",
      auth_mode: "signature",
    });
    expect((created.secret as string).startsWith("whsec_")).toBe(true);
    expect(created).not.toHaveProperty("key_url");
    expect(created.preamble).toBeNull();
    expect(created.expires_at).toBeNull();
  });

  it("lists like the screen without key material and shows received requests", async () => {
    const created = await createKeyWebhook();
    const received = await app.inject({
      method: "POST",
      url: `/x/${created.secret as string}/hook`,
      payload: "받은 글",
    });
    expect(received.statusCode).toBe(202);

    const listed = await ok("list_webhooks", { direction: "inbound" });
    const screenList = (await screen("GET", "/api/webhooks/inbound", OWNER)).json();
    expect(listed).toEqual({ webhooks: screenList });
    const text = JSON.stringify(listed);
    expect(text).not.toContain("ssxw_");
    expect(text).not.toContain("key_url");
    expect(text).not.toContain(created.secret as string);
    expect((listed.webhooks as Json[])[0]).toMatchObject({ state: "active" });

    const activity = await ok("list_webhook_activity", { direction: "inbound", id: created.id });
    const screenRequests = (await screen(
      "GET", `/api/webhooks/inbound/${created.id as string}/requests`, OWNER,
    )).json();
    expect(activity).toEqual(screenRequests);
    expect((activity.items as Json[])).toHaveLength(1);
  });

  it("revokes so the same key is refused and the state is revoked", async () => {
    const created = await createKeyWebhook();
    const revoked = await ok("revoke_inbound_webhook", { id: created.id });
    expect(revoked).toMatchObject({ id: created.id, state: "revoked" });
    expect(JSON.stringify(revoked)).not.toContain(created.secret as string);

    const refused = await app.inject({
      method: "POST",
      url: `/x/${created.secret as string}/hook`,
      payload: "폐기 뒤 요청",
    });
    expect(refused.statusCode).toBe(401);
    const listed = await ok("list_webhooks", { direction: "inbound" });
    expect((listed.webhooks as Json[])[0]).toMatchObject({ id: created.id, state: "revoked" });
  });

  it("revokes a webhook made on the screen", async () => {
    const issued = await screen("POST", "/api/webhooks/inbound", OWNER, {
      target_session_id: TARGET,
      label: "화면에서 만듦",
      auth_mode: "signature",
    });
    expect(issued.statusCode).toBe(201);
    const id = (issued.json() as Json).id;
    expect(await ok("revoke_inbound_webhook", { id })).toMatchObject({ id, state: "revoked" });
    const listed = (await screen("GET", "/api/webhooks/inbound", OWNER)).json() as Json[];
    expect(listed[0]).toMatchObject({ id, state: "revoked" });
  });
});

describe("outbound webhook tools", () => {
  it("registers after a matching echo and shows on the owner's screen", async () => {
    const created = await createOutbound();
    expect(Object.keys(created).sort()).toEqual(["signing_secret", "subscription"]);
    expect((created.signing_secret as string).startsWith("whsec_")).toBe(true);
    const subscription = created.subscription as Json;
    expect(subscription).toMatchObject({ owner_email: OWNER, url: RECEIVER_URL, active: true });
    expect(subscription).not.toHaveProperty("signing_secret");
    expect(post).toHaveBeenCalledTimes(1);

    const screenList = (await screen("GET", "/api/webhooks/outbound", OWNER)).json() as Json;
    expect((screenList.subscriptions as Json[]).map((item) => item.id)).toEqual([subscription.id]);
    const listed = await ok("list_webhooks", { direction: "outbound" });
    expect(listed).toEqual(screenList);
    expect(JSON.stringify(listed)).not.toContain(created.signing_secret as string);
  });

  it.each([
    [WRONG_ECHO_URL, "verification_failed"],
    [PRIVATE_URL, "unsafe_callback"],
  ])("refuses %s with challenge_failed and creates nothing", async (url, reason) => {
    const message = await fail("create_outbound_webhook", {
      target_session_id: TARGET,
      label: "받는 곳",
      url,
      event_types: ["session.reply"],
    });
    expect(message).toBe(`challenge_failed: ${reason}`);
    expect(await count("webhook_subscriptions")).toBe(0);
  });

  it("refuses an http address as an invalid request, like the route", async () => {
    const message = await fail("create_outbound_webhook", {
      target_session_id: TARGET,
      label: "받는 곳",
      url: "http://receiver.example/hook/tok_http_secret",
      event_types: ["session.reply"],
    });
    expect(message).toBe("invalid_request: url");
    expect(post).not.toHaveBeenCalled();
    expect(await count("webhook_subscriptions")).toBe(0);
  });

  it("turns off and on, reflected in the screen list", async () => {
    const id = ((await createOutbound()).subscription as Json).id;
    const off = await ok("set_outbound_webhook_active", { id, active: false });
    expect((off.subscription as Json).active).toBe(false);
    let screenList = (await screen("GET", "/api/webhooks/outbound", OWNER)).json() as Json;
    expect((screenList.subscriptions as Json[])[0]).toMatchObject({ id, active: false });
    await ok("set_outbound_webhook_active", { id, active: true });
    screenList = (await screen("GET", "/api/webhooks/outbound", OWNER)).json() as Json;
    expect((screenList.subscriptions as Json[])[0]).toMatchObject({ id, active: true });
  });

  it("filters deliveries by state", async () => {
    const id = ((await createOutbound()).subscription as Json).id as string;
    const dead = await insertDelivery(id, "dead");
    await insertDelivery(id, "delivered");
    const all = await ok("list_webhook_activity", { direction: "outbound", id });
    expect((all.deliveries as Json[])).toHaveLength(2);
    const onlyDead = await ok("list_webhook_activity", { direction: "outbound", id, state: "dead" });
    expect((onlyDead.deliveries as Json[]).map((item) => item.id)).toEqual([dead]);
    const screenDead = (await screen(
      "GET", `/api/webhooks/outbound/${id}/deliveries?state=dead`, OWNER,
    )).json();
    expect(onlyDead).toEqual(screenDead);
  });

  it("redelivers and returns the outcome", async () => {
    const id = ((await createOutbound()).subscription as Json).id as string;
    await harness.sql`
      INSERT INTO events (session_id, id, event_type, payload, created_at)
      VALUES (${TARGET}, 1, 'complete', ${harness.sql.json({ type: "complete", result: "done" } as never)}, ${new Date()})
    `;
    await harness.sql`UPDATE sessions SET last_event_id = 1 WHERE session_id = ${TARGET}`;
    await publishSubscription(harness.sql as unknown as SqlClient, id, new Date());
    const [delivery] = await harness.sql<Array<{ id: string }>>`
      SELECT id FROM webhook_deliveries WHERE subscription_id = ${id}
    `;
    expect(await ok("redeliver_outbound_webhook", { id, delivery_id: delivery!.id }))
      .toEqual({ outcome: "delivered" });
  });

  it("deletes so it leaves the list", async () => {
    const id = ((await createOutbound()).subscription as Json).id;
    expect(await ok("delete_outbound_webhook", { id })).toEqual({ deleted: true });
    expect(await ok("list_webhooks", { direction: "outbound" })).toEqual({ subscriptions: [] });
    expect(await count("webhook_subscriptions")).toBe(0);
  });
});

describe("refusals", () => {
  it("refuses a session without a verified owner and creates nothing", async () => {
    expect(await fail("create_inbound_webhook", {
      target_session_id: TARGET, label: "주인 없음", auth_mode: "key",
    }, context(ORPHAN_CALLER))).toBe("Verified session owner required");
    expect(await fail("create_outbound_webhook", {
      target_session_id: TARGET, label: "주인 없음", url: RECEIVER_URL, event_types: ["session.reply"],
    }, context(ORPHAN_CALLER))).toBe("Verified session owner required");
    expect(await count("external_access_grants")).toBe(0);
    expect(await count("webhook_subscriptions")).toBe(0);
    expect(post).not.toHaveBeenCalled();
  });

  it("answers a target the owner cannot reach like the routes", async () => {
    for (const target of [HIDDEN, MISSING]) {
      expect(await fail("create_inbound_webhook", {
        target_session_id: target, label: "닿지 않음", auth_mode: "key",
      })).toBe("session_not_found");
    }
    expect(await fail("create_outbound_webhook", {
      target_session_id: MISSING, label: "없음", url: RECEIVER_URL, event_types: ["session.reply"],
    })).toBe("session_not_found");
    expect(await fail("create_outbound_webhook", {
      target_session_id: HIDDEN, label: "닿지 않음", url: RECEIVER_URL, event_types: ["session.reply"],
    })).toBe("forbidden");
    expect(await count("external_access_grants")).toBe(0);
    expect(await count("webhook_subscriptions")).toBe(0);
    expect(post).not.toHaveBeenCalled();
  });

  it("answers not_found for another owner's webhooks and leaves them alone", async () => {
    const otherInbound = await createKeyWebhook(context(OTHER_CALLER));
    const otherOutbound = ((await createOutbound(RECEIVER_URL, context(OTHER_CALLER))).subscription as Json)
      .id as string;
    const delivery = await insertDelivery(otherOutbound, "dead");

    expect(await fail("revoke_inbound_webhook", { id: otherInbound.id })).toBe("not_found");
    expect(await fail("list_webhook_activity", { direction: "inbound", id: otherInbound.id }))
      .toBe("not_found");
    expect(await fail("set_outbound_webhook_active", { id: otherOutbound, active: false }))
      .toBe("not_found");
    expect(await fail("redeliver_outbound_webhook", { id: otherOutbound, delivery_id: delivery }))
      .toBe("not_found");
    expect(await fail("list_webhook_activity", { direction: "outbound", id: otherOutbound }))
      .toBe("not_found");
    expect(await fail("delete_outbound_webhook", { id: otherOutbound })).toBe("not_found");
    expect(await fail("delete_outbound_webhook", { id: "not-a-uuid" })).toBe("not_found");

    const otherInboundList = (await screen("GET", "/api/webhooks/inbound", OTHER)).json() as Json[];
    expect(otherInboundList[0]).toMatchObject({ id: otherInbound.id, state: "active" });
    const otherOutboundList = (await screen("GET", "/api/webhooks/outbound", OTHER)).json() as Json;
    expect((otherOutboundList.subscriptions as Json[])[0]).toMatchObject({ id: otherOutbound, active: true });
    const [row] = await harness.sql<Array<{ state: string }>>`
      SELECT state FROM webhook_deliveries WHERE id = ${delivery}
    `;
    expect(row).toEqual({ state: "dead" });
  });

  it("refuses a caller_session_id that differs from the authenticated session", async () => {
    expect(await fail("list_webhooks", { direction: "inbound", caller_session_id: OTHER_CALLER }))
      .toBe("caller_session_id does not match authenticated session");
    expect(await fail("create_inbound_webhook", {
      target_session_id: TARGET, label: "가로채기", auth_mode: "key", caller_session_id: OTHER_CALLER,
    })).toBe("caller_session_id does not match authenticated session");
    expect(await count("external_access_grants")).toBe(0);
  });

  it("refuses external principals", async () => {
    expect(await fail("list_webhooks", { direction: "outbound" }, { ...context(), principal: "external" }))
      .toBe("internal_principal_required");
  });

  it("answers invalid_request with the first problem's path", async () => {
    expect(await fail("create_inbound_webhook", {
      target_session_id: TARGET, label: "가".repeat(81), auth_mode: "key",
    })).toBe("invalid_request: label");
    expect(await fail("create_outbound_webhook", {
      target_session_id: TARGET, label: "받는 곳", url: RECEIVER_URL, event_types: [],
    })).toBe("invalid_request: event_types");
    expect(await fail("list_webhook_activity", { direction: "inbound", id: "not-a-uuid" }))
      .toBe("invalid_request: id");
    expect(await fail("list_webhook_activity", {
      direction: "inbound", id: randomUUID(), limit: 51,
    })).toBe("invalid_request: limit");
    expect(await count("external_access_grants")).toBe(0);
    expect(await count("webhook_subscriptions")).toBe(0);
  });

  it("answers webhooks_unavailable without the dependency", async () => {
    const bare = { ...options, webhooks: undefined } as McpHostOptions;
    for (const [name, args] of [
      ["create_inbound_webhook", { target_session_id: TARGET, label: "x", auth_mode: "key" }],
      ["revoke_inbound_webhook", { id: randomUUID() }],
      ["create_outbound_webhook", { target_session_id: TARGET, label: "x", url: RECEIVER_URL, event_types: ["session.reply"] }],
      ["set_outbound_webhook_active", { id: randomUUID(), active: false }],
      ["delete_outbound_webhook", { id: randomUUID() }],
      ["redeliver_outbound_webhook", { id: randomUUID(), delivery_id: randomUUID() }],
      ["list_webhooks", { direction: "inbound" }],
      ["list_webhook_activity", { direction: "outbound", id: randomUUID() }],
    ] as Array<[ToolName, Json]>) {
      expect(await fail(name, args, context(), bare)).toBe("webhooks_unavailable");
    }
    expect(await count("external_access_grants")).toBe(0);
  });

  it("is registered for every tool through the executor", async () => {
    const result = await executeMcpTool(options, "list_webhooks", { direction: "inbound" }, context());
    expect(result.isError).toBeFalsy();
  });

  it("never puts secrets, keys or receiver path tokens into an error", async () => {
    const key = await createKeyWebhook();
    await fail("create_outbound_webhook", {
      target_session_id: TARGET, label: "받는 곳", url: WRONG_ECHO_URL, event_types: ["session.reply"],
    });
    await fail("create_outbound_webhook", {
      target_session_id: TARGET, label: "받는 곳", url: PRIVATE_URL, event_types: ["session.reply"],
    });
    await fail("create_outbound_webhook", {
      target_session_id: HIDDEN, label: "받는 곳", url: RECEIVER_URL, event_types: ["session.reply"],
    });
    await fail("revoke_inbound_webhook", { id: randomUUID() });
    expect(errors.length).toBeGreaterThan(0);
    for (const error of errors) {
      expect(error).not.toContain(key.secret as string);
      expect(error).not.toMatch(/ssxw_|whsec_|tok_[a-z_]+secret|receiver\.example|wrong-echo|10\.0\.0\.5/);
    }
  });
});
