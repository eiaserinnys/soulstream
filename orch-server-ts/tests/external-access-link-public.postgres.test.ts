/**
 * card #1457 — the public access link surface against the real store.
 *
 * A link key drives guidance, admission, long-poll status, history, and stop.
 * The link's lifetime and kind are enforced on every request, the ledger keeps
 * the server-built caller info, and a webhook key never opens this surface.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { SqlClient } from "../src/control_plane/control_plane_types.js";
import { ConversationHistory } from "../src/conversation/conversation_history.js";
import {
  ExternalAccessGrantRepository,
  type ExternalAccessGrant,
} from "../src/external_access/external_access_grant_repository.js";
import { ExternalAccessTokenBucket } from "../src/external_access/external_access_token_bucket.js";
import { ExternalReplySignal } from "../src/external_access/external_reply_signal.js";
import { ExternalInputService } from "../src/external_access/external_input_service.js";
import {
  registerExternalAccessPublicRoutes,
  type ExternalAccessStopOutcome,
} from "../src/external_access/public_link_routes.js";
import { externalAccessHandlers } from "../src/mcp/external_access_handlers.js";
import { RuntimeSessionEventHub } from "../src/runtime/session_event_hub.js";
import {
  createFullSchemaPostgresHarness,
  type FullSchemaPostgresHarness,
} from "./board_yjs_postgres_harness.js";

const OWNER_EMAIL = "owner@example.com";
const TARGET_SESSION = "link-public-target-session";
const PUBLIC_URL = "https://soulstream.example.test/";

type RouteApp = {
  app: FastifyInstance;
  bucket: ExternalAccessTokenBucket;
  eventHub: RuntimeSessionEventHub;
  replySignal: ExternalReplySignal;
};

describe("external access public link routes (postgres)", () => {
  let db: FullSchemaPostgresHarness;
  let sql: SqlClient;
  let repository: ExternalAccessGrantRepository;

  beforeAll(async () => {
    db = await createFullSchemaPostgresHarness();
    sql = db.sql as unknown as SqlClient;
    repository = new ExternalAccessGrantRepository({
      sql,
      authorizeUser: async () => null,
      requireSessionAccess: async () => undefined,
    });
  }, 120_000);

  beforeEach(async () => {
    await db.sql`DELETE FROM external_replies`;
    await db.sql`DELETE FROM session_delivery_attempts`;
    await db.sql`DELETE FROM session_delivery_relation_consumptions`;
    await db.sql`DELETE FROM session_deliveries`;
    await db.sql`DELETE FROM external_input_receipts`;
    await db.sql`DELETE FROM external_access_grants`;
    await db.sql`DELETE FROM events`;
    await db.sql`DELETE FROM sessions`;
    await db.sql`DELETE FROM users`;
    await db.sql`
      INSERT INTO users (email, display_name) VALUES (${OWNER_EMAIL}, '링크 발급자')
    `;
    await db.sql`
      INSERT INTO sessions (session_id, display_name, agent_id, status)
      VALUES (${TARGET_SESSION}, '링크 대상 세션', 'roselin', 'running')
    `;
  });

  afterAll(async () => {
    await db?.cleanup();
  });

  async function issueLink(
    permissions: ExternalAccessGrant["permissions"] = [
      "send",
      "read_own",
      "read_history",
      "control",
    ],
  ): Promise<{ grant: { id: string }; key: string; url: string }> {
    const issued = await repository.issue({
      kind: "link",
      ownerEmail: OWNER_EMAIL,
      label: "외부 링크",
      targetSessionId: TARGET_SESSION,
      permissions,
      expiresInSeconds: 3_600,
    });
    return {
      grant: issued.grant,
      key: issued.key,
      url: `/x/${issued.key}`,
    };
  }

  function createRouteApp(options: {
    bucket?: ExternalAccessTokenBucket;
    stopSession?: () => Promise<ExternalAccessStopOutcome>;
  } = {}): RouteApp {
    const bucket = options.bucket ?? new ExternalAccessTokenBucket();
    const eventHub = new RuntimeSessionEventHub();
    const replySignal = new ExternalReplySignal();
    const inputService = new ExternalInputService({
      sql,
      grants: repository,
      dispatch: async () => ({ status: 200, body: { ok: true } }),
      tokenBucket: bucket,
    });
    const app = Fastify();
    registerExternalAccessPublicRoutes(app, {
      sql,
      publicUrl: PUBLIC_URL,
      grants: repository,
      inputService,
      history: new ConversationHistory(sql),
      stopSession: options.stopSession ?? (async () => "stopped"),
      tokenBucket: bucket,
      eventHub,
      replySignal,
    });
    return { app, bucket, eventHub, replySignal };
  }

  async function lastUsedAt(grantId: string): Promise<Date | null> {
    const rows = await db.sql<Array<{ last_used_at: Date | null }>>`
      SELECT last_used_at FROM external_access_grants WHERE id = ${grantId}
    `;
    return rows[0]?.last_used_at ?? null;
  }

  it("serves guidance without touching last_used_at and names only the target display name", async () => {
    const { grant, key, url } = await issueLink();
    const { app } = createRouteApp();
    try {
      const text = await app.inject({ method: "GET", url });
      expect(text.statusCode).toBe(200);
      expect(text.body).toContain("링크 대상 세션");
      expect(text.body).not.toContain(TARGET_SESSION);
      expect(text.body).toContain(`https://soulstream.example.test/x/${key}/messages`);
      expect(text.body).toContain("/history?limit=50");
      expect(text.body).toContain("/stop");
      expect(await lastUsedAt(grant.id)).toBeNull();

      const json = await app.inject({
        method: "GET",
        url,
        headers: { accept: "application/json" },
      });
      expect(json.statusCode).toBe(200);
      const body = json.json() as { target: { display_name: string } };
      expect(body.target.display_name).toBe("링크 대상 세션");
      expect(await lastUsedAt(grant.id)).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("admits a message with server-built caller info and completes a held status read on a reply", async () => {
    const { grant, url } = await issueLink();
    const { app, replySignal } = createRouteApp();
    try {
      const accepted = await app.inject({
        method: "POST",
        url: `${url}/messages`,
        headers: {
          cookie: "session=ignored-cookie",
          authorization: "Bearer ignored-token",
        },
        payload: { text: "상태를 알려주세요", request_id: "roundtrip-1" },
      });
      expect(accepted.statusCode).toBe(202);
      expect(accepted.json()).toEqual({
        request_id: "roundtrip-1",
        status: "accepted",
      });
      expect(await lastUsedAt(grant.id)).not.toBeNull();

      const receipts = await db.sql<Array<{ caller_info: Record<string, unknown> }>>`
        SELECT caller_info FROM external_input_receipts
        WHERE grant_id = ${grant.id} AND request_id = ${"roundtrip-1"}
      `;
      expect(receipts).toHaveLength(1);
      expect(receipts[0]?.caller_info).toMatchObject({
        source: "external",
        transport: "access_link",
        grant_id: grant.id,
        display_name: "외부 링크",
        user_id: null,
        issued_by: OWNER_EMAIL,
      });

      const startedAt = Date.now();
      const pending = app.inject({
        method: "GET",
        url: `${url}/messages/roundtrip-1?wait=25`,
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      // The reply goes through the MCP handler the deployed agent uses. It
      // splits the stored request handle at the first colon before signalling,
      // so this proves the long poll is woken by the real handle form.
      const replyCallAt = Date.now();
      const reply = await externalAccessHandlers.reply_to_external_request(
        {
          externalAccess: { sql, replySignal },
          cluster: { logger: app.log },
        } as never,
        {
          request_handle: `${grant.id}:roundtrip-1`,
          text: "완료했습니다.",
          final: true,
        },
        { principal: "internal", callerSessionId: TARGET_SESSION, nodeId: "test-node" },
      );
      expect(reply.isError).not.toBe(true);
      expect(reply.structuredContent).toMatchObject({
        request_handle: `${grant.id}:roundtrip-1`,
        final: true,
      });
      const woken = await pending;
      const elapsed = Date.now() - startedAt;
      const wokeAfterCall = Date.now() - replyCallAt;
      expect(woken.statusCode).toBe(200);
      expect(woken.json()).toMatchObject({
        request_id: "roundtrip-1",
        status: "completed",
        outcome: "replied",
        replies: [{ text: "완료했습니다." }],
      });
      expect(elapsed).toBeLessThan(10_000);
      expect(elapsed).toBeGreaterThanOrEqual(300);
      expect(wokeAfterCall).toBeLessThan(3_000);
    } finally {
      await app.close();
    }
  });

  it("answers a revoked link during a wait with 401 and no data", async () => {
    const { grant, url } = await issueLink();
    const { app } = createRouteApp();
    try {
      const accepted = await app.inject({
        method: "POST",
        url: `${url}/messages`,
        payload: { text: "기다리는 동안 폐기", request_id: "revoked-1" },
      });
      expect(accepted.statusCode).toBe(202);

      const pending = app.inject({
        method: "GET",
        url: `${url}/messages/revoked-1?wait=1`,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await repository.revoke(OWNER_EMAIL, grant.id, "link")).not.toBeNull();
      const response = await pending;
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: { code: "unauthorized", message: "Unauthorized" },
      });
      expect(JSON.stringify(response.json())).not.toContain("revoked-1");

      const guidance = await app.inject({ method: "GET", url });
      expect(guidance.statusCode).toBe(401);
      expect(guidance.body).toBe(response.body);
    } finally {
      await app.close();
    }
  });

  it("keeps request_id idempotency and reports a conflict for a different body", async () => {
    const { url } = await issueLink();
    const { app } = createRouteApp();
    try {
      const first = await app.inject({
        method: "POST",
        url: `${url}/messages`,
        payload: { text: "같은 요청", request_id: "idem-1" },
      });
      expect(first.statusCode).toBe(202);
      const retried = await app.inject({
        method: "POST",
        url: `${url}/messages`,
        payload: { text: "같은 요청", request_id: "idem-1" },
      });
      expect(retried.statusCode).toBe(202);
      expect(retried.json()).toEqual(first.json());

      const conflict = await app.inject({
        method: "POST",
        url: `${url}/messages`,
        payload: { text: "다른 요청", request_id: "idem-1" },
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toEqual({
        error: {
          code: "request_conflict",
          message: "request_id was already used with a different text",
        },
      });
    } finally {
      await app.close();
    }
  });

  it("rate limits sends with 429 and Retry-After", async () => {
    const { url } = await issueLink();
    const bucket = new ExternalAccessTokenBucket({ now: () => 0 });
    const { app } = createRouteApp({ bucket });
    try {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const response = await app.inject({
          method: "POST",
          url: `${url}/messages`,
          payload: { text: `메시지 ${attempt}`, request_id: `rate-${attempt}` },
        });
        expect(response.statusCode).toBe(202);
      }
      const limited = await app.inject({
        method: "POST",
        url: `${url}/messages`,
        payload: { text: "넘침", request_id: "rate-overflow" },
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBeDefined();
      expect(limited.json()).toEqual({
        error: { code: "rate_limited", message: "Too many requests" },
      });
      const rows = await db.sql<Array<{ count: string }>>`
        SELECT COUNT(*)::text AS count FROM external_input_receipts
        WHERE request_id = ${"rate-overflow"}
      `;
      expect(rows[0]?.count).toBe("0");
    } finally {
      await app.close();
    }
  });

  it("answers expired, revoked, and wrong keys with the same 401 body", async () => {
    const expired = await issueLink();
    await db.sql`
      UPDATE external_access_grants
      SET expires_at = NOW() - INTERVAL '1 minute'
      WHERE id = ${expired.grant.id}
    `;
    const revoked = await issueLink();
    await repository.revoke(OWNER_EMAIL, revoked.grant.id, "link");
    const { app } = createRouteApp();
    try {
      const responses = await Promise.all([
        app.inject({ method: "GET", url: expired.url }),
        app.inject({ method: "GET", url: revoked.url }),
        app.inject({ method: "GET", url: "/x/ssxl_aaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }),
      ]);
      for (const response of responses) {
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({
          error: { code: "unauthorized", message: "Unauthorized" },
        });
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.headers["referrer-policy"]).toBe("no-referrer");
      }
    } finally {
      await app.close();
    }
  });

  it("never opens the surface for an inbound webhook kind key", async () => {
    const webhook = await repository.issue({
      kind: "inbound_webhook",
      ownerEmail: OWNER_EMAIL,
      label: "웹훅",
      targetSessionId: TARGET_SESSION,
      permissions: ["send"],
      expiresInSeconds: null,
    });
    expect(webhook.key.startsWith("ssxw_")).toBe(true);
    const { app } = createRouteApp();
    try {
      const wrong = await app.inject({ method: "GET", url: "/x/ssxl_cccccccccccccccccccccc_ddddddddddddddddddddddddddddddddddddddddddd" });
      expect(wrong.statusCode).toBe(401);
      const unauthorizedBody = wrong.json();

      const paths = [
        { method: "GET" as const, url: `/x/${webhook.key}` },
        { method: "POST" as const, url: `/x/${webhook.key}/messages`, payload: { text: "안녕" } },
        { method: "GET" as const, url: `/x/${webhook.key}/messages/anything?wait=1` },
        { method: "GET" as const, url: `/x/${webhook.key}/history` },
        { method: "POST" as const, url: `/x/${webhook.key}/stop` },
      ];
      for (const path of paths) {
        const response = path.payload === undefined
          ? await app.inject({ method: path.method, url: path.url })
          : await app.inject({ method: path.method, url: path.url, payload: path.payload });
        expect(response.statusCode, path.url).toBe(401);
        expect(response.json(), path.url).toEqual(unauthorizedBody);
      }
      const receipts = await db.sql<Array<{ count: string }>>`
        SELECT COUNT(*)::text AS count FROM external_input_receipts
        WHERE grant_id = ${webhook.grant.id}
      `;
      expect(receipts[0]?.count).toBe("0");
      const [grantRow] = await db.sql<Array<{ revoked_at: Date | null }>>`
        SELECT revoked_at FROM external_access_grants WHERE id = ${webhook.grant.id}
      `;
      expect(grantRow?.revoked_at).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("projects only user and assistant history items with before and limit", async () => {
    const { url } = await issueLink();
    const insert = async (
      id: number,
      eventType: string,
      payload: Record<string, unknown>,
      at: string,
    ) => {
      await db.sql`
        INSERT INTO events (session_id, id, event_type, payload, created_at)
        VALUES (${TARGET_SESSION}, ${id}, ${eventType}, ${db.sql.json(payload as never)}, ${at})
      `;
    };
    await insert(1, "user_message", {
      text: "첫 질문",
      caller_info: { source: "browser" },
    }, "2026-11-01T00:00:00Z");
    await insert(2, "assistant_message", { content: "첫 답" }, "2026-11-01T00:00:01Z");
    await insert(3, "tool_start", { tool_name: "Read" }, "2026-11-01T00:00:02Z");
    await insert(4, "user_message", {
      text: "외부 질문",
      caller_info: { source: "external", display_name: "외부 링크" },
    }, "2026-11-01T00:00:03Z");
    await insert(5, "error", { message: "내부 오류" }, "2026-11-01T00:00:04Z");
    await insert(6, "assistant_message", { content: "둘째 답" }, "2026-11-01T00:00:05Z");

    const { app } = createRouteApp();
    try {
      const all = await app.inject({ method: "GET", url: `${url}/history` });
      expect(all.statusCode).toBe(200);
      const body = all.json() as {
        items: Array<{
          id: string;
          role: string;
          text: string;
          at: string;
          sender?: { kind: string; label: string };
        }>;
      };
      expect(body.items.map((item) => item.text)).toEqual([
        "첫 질문",
        "첫 답",
        "외부 질문",
        "둘째 답",
      ]);
      expect(body.items.map((item) => item.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
      ]);
      expect(body.items[2]?.sender).toEqual({
        kind: "external",
        label: "외부 링크",
      });
      expect(body.items[0]).not.toHaveProperty("sender");
      expect(JSON.stringify(body)).not.toContain("내부 오류");
      expect(JSON.stringify(body)).not.toContain("Read");
      expect(JSON.stringify(body)).not.toContain("attachments");

      const page = await app.inject({
        method: "GET",
        url: `${url}/history?limit=2&before=${encodeURIComponent(body.items[3]!.id)}`,
      });
      expect(page.statusCode).toBe(200);
      const pageBody = page.json() as {
        items: Array<{ text: string }>;
        next_before?: string;
      };
      expect(pageBody.items.map((item) => item.text)).toEqual(["첫 답", "외부 질문"]);
      expect(pageBody.next_before).toBeDefined();

      const unknown = await app.inject({
        method: "GET",
        url: `${url}/history?before=0:999`,
      });
      expect(unknown.statusCode).toBe(400);
      expect(unknown.json()).toEqual({
        error: { code: "invalid_before", message: "Unknown before cursor" },
      });
    } finally {
      await app.close();
    }
  });

  it("stops a running target and reports a non-running target as 409", async () => {
    const stopped = await issueLink();
    const calls: string[] = [];
    const { app } = createRouteApp({
      stopSession: async () => {
        calls.push("called");
        return "stopped";
      },
    });
    try {
      const response = await app.inject({ method: "POST", url: `${stopped.url}/stop` });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      expect(calls).toEqual(["called"]);
      expect(await lastUsedAt(stopped.grant.id)).not.toBeNull();
    } finally {
      await app.close();
    }

    const idle = await issueLink();
    const notRunning = createRouteApp({ stopSession: async () => "not_running" });
    try {
      const response = await notRunning.app.inject({
        method: "POST",
        url: `${idle.url}/stop`,
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: { code: "not_running", message: "Session is not running" },
      });
    } finally {
      await notRunning.app.close();
    }
  });

  it("refuses actions the link lacks permission for and answers unknown /x paths with the fixed 404", async () => {
    const sendOnly = await issueLink(["send"]);
    const { app } = createRouteApp();
    try {
      const history = await app.inject({ method: "GET", url: `${sendOnly.url}/history` });
      expect(history.statusCode).toBe(403);
      const stop = await app.inject({ method: "POST", url: `${sendOnly.url}/stop` });
      expect(stop.statusCode).toBe(403);
      const status = await app.inject({ method: "GET", url: `${sendOnly.url}/messages/x` });
      expect(status.statusCode).toBe(403);

      const missing = await app.inject({ method: "GET", url: `${sendOnly.url}/unknown` });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({
        error: { code: "not_found", message: "Not found" },
      });
      expect(missing.headers["cache-control"]).toBe("no-store");
      expect(missing.headers["referrer-policy"]).toBe("no-referrer");
    } finally {
      await app.close();
    }
  });
});
