/**
 * card #1458 — inbound webhook management against real Postgres: the real grant
 * repository issues, lists, finds and revokes; the real ExternalInputService
 * reads receipts, the ledger and replies. The management routes and the receive
 * routes share one app, so an issued secret is used to receive for real.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { parseOrchServerConfig } from "../src/config.js";
import type { SqlClient } from "../src/control_plane/control_plane_types.js";
import {
  ExternalAccessGrantRepository,
} from "../src/external_access/external_access_grant_repository.js";
import { ExternalInputService } from "../src/external_access/external_input_service.js";
import { writeExternalReply } from "../src/external_access/external_reply_service.js";
import { SessionResourceAccessError } from "../src/session/session_resource_access.js";
import { standardWebhookHeaders } from "../src/webhooks/standard_webhook_signature.js";
import type { InboundWebhookRouteOptions } from
  "../src/webhooks/inbound_webhook_routes.js";
import { createPagePostgresHarness, type PagePostgresHarness } from
  "./page/page_postgres_harness.js";

const OWNER_EMAIL = "owner@example.com";
const OTHER_EMAIL = "other@example.com";
const PUBLIC_URL = "https://soulstream.example.test/";
const TARGET_SESSION = "0f6d8c2a-4b31-4d7e-9a15-9c8b7a6d5e4f";
const DENIED_SESSION = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const MISSING_SESSION = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

function extractSchemaBlock(schemaSql: string, pattern: RegExp): string {
  const match = schemaSql.match(pattern);
  if (match === null) throw new Error(`schema block not found: ${pattern}`);
  return match[0];
}

describe("inbound webhook management", () => {
  let harness: PagePostgresHarness;
  let dispatched: Array<{ targetSessionId: string; body: Record<string, unknown> }>;

  beforeAll(async () => {
    harness = await createPagePostgresHarness();
    const schemaSql = await readFile(
      new URL("../../packages/db-schema/sql/schema.sql", import.meta.url),
      "utf8",
    );
    await harness.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS users (
        email TEXT PRIMARY KEY,
        display_name TEXT,
        is_admin BOOLEAN NOT NULL DEFAULT FALSE,
        allowed_folder_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by TEXT
      );
    `);
    await harness.sql.unsafe(extractSchemaBlock(
      schemaSql,
      /CREATE TABLE IF NOT EXISTS external_access_grants \([\s\S]*?\n\);/,
    ));
    await harness.sql.unsafe(extractSchemaBlock(
      schemaSql,
      /CREATE TABLE IF NOT EXISTS external_input_receipts \([\s\S]*?\n\);/,
    ));
    await harness.sql.unsafe(extractSchemaBlock(
      schemaSql,
      /CREATE TABLE IF NOT EXISTS external_replies \([\s\S]*?\n\);/,
    ));
    await harness.sql.unsafe(extractSchemaBlock(
      schemaSql,
      /CREATE UNIQUE INDEX IF NOT EXISTS uq_external_replies_final[\s\S]*?;/,
    ));
    await harness.sql.unsafe(extractSchemaBlock(
      schemaSql,
      /CREATE TABLE IF NOT EXISTS session_deliveries \([\s\S]*?\n\);/,
    ));
    await harness.sql.unsafe(extractSchemaBlock(
      schemaSql,
      /ALTER TABLE session_deliveries\n    ADD COLUMN IF NOT EXISTS aggregate_state[\s\S]*?;/,
    ));
    await harness.sql.unsafe(extractSchemaBlock(
      schemaSql,
      /ALTER TABLE session_deliveries\n    ADD CONSTRAINT session_deliveries_aggregate_state_check[\s\S]*?;/,
    ));
    await harness.sql.unsafe(extractSchemaBlock(
      schemaSql,
      /CREATE TABLE IF NOT EXISTS session_delivery_attempts \([\s\S]*?\n\);/,
    ));
    await harness.sql.unsafe(extractSchemaBlock(
      schemaSql,
      /CREATE TABLE IF NOT EXISTS session_delivery_relation_consumptions \([\s\S]*?\n\);/,
    ));
    await harness.sql.unsafe(
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS termination_event_id INTEGER`,
    );
  }, 60_000);

  beforeEach(async () => {
    dispatched = [];
    await harness.sql`DELETE FROM session_delivery_attempts`;
    await harness.sql`DELETE FROM session_delivery_relation_consumptions`;
    await harness.sql`DELETE FROM session_deliveries`;
    await harness.sql`DELETE FROM external_replies`;
    await harness.sql`DELETE FROM external_input_receipts`;
    await harness.sql`DELETE FROM external_access_grants`;
    await harness.sql`DELETE FROM sessions`;
    await harness.sql`DELETE FROM users`;
    await harness.sql`
      INSERT INTO users (email, display_name) VALUES
        (${OWNER_EMAIL}, '테스트 사용자'), (${OTHER_EMAIL}, '다른 사용자')
    `;
    await harness.sql`
      INSERT INTO sessions (session_id, status) VALUES (${TARGET_SESSION}, 'running')
    `;
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  function judgeSessionAccess(sessionId: string): void {
    if (sessionId === DENIED_SESSION) {
      throw new SessionResourceAccessError(
        "SESSION_ACCESS_DENIED",
        "Session access denied",
        403,
      );
    }
    if (sessionId === MISSING_SESSION) {
      throw new SessionResourceAccessError(
        "SESSION_NOT_FOUND",
        "Session not found",
        404,
      );
    }
  }

  function grantRepository(): ExternalAccessGrantRepository {
    return new ExternalAccessGrantRepository({
      sql: harness.sql as unknown as SqlClient,
      authorizeUser: async () => null,
      requireSessionAccess: async (input) => judgeSessionAccess(input.sessionId),
    });
  }

  function createManagementApp(
    overrides: {
      repository?: ExternalAccessGrantRepository;
      service?: ExternalInputService;
      requests?: InboundWebhookRouteOptions["requests"];
      logger?: InboundWebhookRouteOptions["logger"];
    } = {},
  ) {
    const repository = overrides.repository ?? grantRepository();
    const service = overrides.service ?? new ExternalInputService({
      sql: harness.sql as unknown as SqlClient,
      grants: repository,
      dispatch: async (targetSessionId, body) => {
        dispatched.push({ targetSessionId, body });
      },
    });
    const app = createApp({
      config,
      inboundHookRoutes: { grants: repository, service },
      inboundWebhookRoutes: {
        currentEmail: (request) => {
          const header = request.headers["x-user-email"];
          return typeof header === "string" && header.length > 0 ? header : null;
        },
        grants: repository,
        requests: overrides.requests ?? service,
        requireSessionAccess: async (input) => judgeSessionAccess(input.sessionId),
        publicUrl: PUBLIC_URL,
        ...(overrides.logger === undefined ? {} : { logger: overrides.logger }),
      },
    });
    return { app, repository, service };
  }

  function issueRequest(
    app: ReturnType<typeof createApp>,
    payload: Record<string, unknown>,
    email: string | null = OWNER_EMAIL,
  ) {
    return app.inject({
      method: "POST",
      url: "/api/webhooks/inbound",
      headers: email === null ? {} : { "x-user-email": email },
      payload,
    });
  }

  function listRequest(
    app: ReturnType<typeof createApp>,
    email: string | null = OWNER_EMAIL,
  ) {
    return app.inject({
      method: "GET",
      url: "/api/webhooks/inbound",
      headers: email === null ? {} : { "x-user-email": email },
    });
  }

  function requestsRequest(
    app: ReturnType<typeof createApp>,
    id: string,
    options: { limit?: string; email?: string | null } = {},
  ) {
    const email = options.email === undefined ? OWNER_EMAIL : options.email;
    const suffix = options.limit === undefined ? "" : `?limit=${options.limit}`;
    return app.inject({
      method: "GET",
      url: `/api/webhooks/inbound/${id}/requests${suffix}`,
      headers: email === null ? {} : { "x-user-email": email },
    });
  }

  function deleteRequest(
    app: ReturnType<typeof createApp>,
    id: string,
    email: string | null = OWNER_EMAIL,
  ) {
    return app.inject({
      method: "DELETE",
      url: `/api/webhooks/inbound/${id}`,
      headers: email === null ? {} : { "x-user-email": email },
    });
  }

  async function receiveKey(
    app: ReturnType<typeof createApp>,
    grantId: string,
    secret: string,
    body: string,
    extraHeaders: Record<string, string> = {},
  ) {
    return await app.inject({
      method: "POST",
      url: `/api/hooks/${grantId}`,
      payload: body,
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
        ...extraHeaders,
      },
    });
  }

  async function grantRows(): Promise<Array<{
    id: string;
    kind: string;
    auth_mode: string;
    key_hash: string | null;
    signing_secret: string | null;
    preamble: string | null;
    permissions: string[];
    revoked_at: Date | null;
  }>> {
    return await harness.sql<Array<{
      id: string;
      kind: string;
      auth_mode: string;
      key_hash: string | null;
      signing_secret: string | null;
      preamble: string | null;
      permissions: string[];
      revoked_at: Date | null;
    }>>`
      SELECT id, kind, auth_mode, key_hash, signing_secret, preamble,
             permissions, revoked_at
      FROM external_access_grants
    `;
  }

  it("issues a key webhook once and the secret receives into the target session", async () => {
    const { app } = createManagementApp();
    try {
      const response = await issueRequest(app, {
        target_session_id: TARGET_SESSION,
        label: "  빌드 알림  ",
        auth_mode: "key",
      });

      expect(response.statusCode).toBe(201);
      expect(response.headers["cache-control"]).toBe("no-store");
      const body = response.json();
      expect(body).toMatchObject({
        auth_mode: "key",
        label: "빌드 알림",
        target_session_id: TARGET_SESSION,
        preamble: null,
        expires_at: null,
      });
      expect(typeof body.id).toBe("string");
      expect(body.url).toBe(`${PUBLIC_URL.replace(/\/+$/, "")}/api/hooks/${body.id}`);
      expect(body.secret.startsWith("ssxw_")).toBe(true);
      expect(typeof body.created_at).toBe("string");

      const rows = await grantRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: body.id,
        kind: "inbound_webhook",
        auth_mode: "key",
        signing_secret: null,
        preamble: null,
        permissions: ["send", "read_own"],
      });
      expect(rows[0]!.key_hash).toBe(
        createHash("sha256").update(body.secret, "utf8").digest("hex"),
      );

      const received = await receiveKey(
        app,
        body.id,
        body.secret,
        "{\"text\":\"키 발급 확인\"}",
      );
      expect(received.statusCode).toBe(202);
      expect(received.json()).toMatchObject({ status: "accepted" });
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]!.targetSessionId).toBe(TARGET_SESSION);
    } finally {
      await app.close();
    }
  });

  it("issues a signature webhook with a preamble and an expiry", async () => {
    const { app } = createManagementApp();
    try {
      const response = await issueRequest(app, {
        target_session_id: TARGET_SESSION,
        label: "서명 웹훅",
        auth_mode: "signature",
        preamble: "빌드 결과 자료입니다",
        expires_in_seconds: 3600,
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.auth_mode).toBe("signature");
      expect(body.secret.startsWith("whsec_")).toBe(true);
      expect(body.preamble).toBe("빌드 결과 자료입니다");
      expect(Date.parse(body.expires_at)).toBeGreaterThan(Date.now());

      const rows = await grantRows();
      expect(rows[0]).toMatchObject({
        id: body.id,
        auth_mode: "signature",
        key_hash: null,
        preamble: "빌드 결과 자료입니다",
      });
      expect(rows[0]!.signing_secret).toBe(body.secret);

      const signedBody = "{\"text\":\"서명 발급 확인\"}";
      const signed = await app.inject({
        method: "POST",
        url: `/api/hooks/${body.id}`,
        payload: signedBody,
        headers: standardWebhookHeaders({
          secret: body.secret,
          webhookId: "wh_issued_signature",
          body: signedBody,
        }),
      });
      expect(signed.statusCode).toBe(202);
      expect(signed.json()).toMatchObject({ status: "accepted" });
    } finally {
      await app.close();
    }
  });

  it("rejects invalid issue bodies with 422 and stores nothing", async () => {
    const { app } = createManagementApp();
    try {
      const invalid = [
        { target_session_id: TARGET_SESSION, auth_mode: "key" },
        {
          target_session_id: TARGET_SESSION,
          label: "모드 오류",
          auth_mode: "basic",
        },
        {
          target_session_id: TARGET_SESSION,
          label: "너무 긴 머리말",
          auth_mode: "key",
          preamble: "x".repeat(4001),
        },
        {
          target_session_id: TARGET_SESSION,
          label: "모르는 필드",
          auth_mode: "key",
          permissions: ["send"],
        },
        {
          target_session_id: TARGET_SESSION,
          label: "짧은 만료",
          auth_mode: "key",
          expires_in_seconds: 59,
        },
        {
          target_session_id: TARGET_SESSION,
          label: "   ",
          auth_mode: "key",
        },
      ];
      for (const payload of invalid) {
        const response = await issueRequest(app, payload);
        expect(response.statusCode, JSON.stringify(payload)).toBe(422);
        expect(response.json()).toEqual({ detail: "Invalid inbound webhook request" });
        expect(response.headers["cache-control"]).toBe("no-store");
      }

      const anonymous = await issueRequest(app, {
        target_session_id: TARGET_SESSION,
        label: "로그인 없음",
        auth_mode: "key",
      }, null);
      expect(anonymous.statusCode).toBe(401);
      expect(anonymous.json()).toEqual({ detail: "Authentication required" });

      expect(await grantRows()).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("answers an unreachable and a missing session with the same 404 and stores nothing", async () => {
    const { app } = createManagementApp();
    try {
      const denied = await issueRequest(app, {
        target_session_id: DENIED_SESSION,
        label: "막힌 세션",
        auth_mode: "key",
      });
      const missing = await issueRequest(app, {
        target_session_id: MISSING_SESSION,
        label: "없는 세션",
        auth_mode: "key",
      });

      expect(denied.statusCode).toBe(404);
      expect(missing.statusCode).toBe(404);
      expect(denied.json()).toEqual(missing.json());
      expect(denied.json()).toEqual({ detail: "Session not found" });
      expect(await grantRows()).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("lists only the caller's inbound webhooks and never key material", async () => {
    const { app, repository } = createManagementApp();
    try {
      const first = (await issueRequest(app, {
        target_session_id: TARGET_SESSION,
        label: "첫 웹훅",
        auth_mode: "key",
      })).json();
      const second = (await issueRequest(app, {
        target_session_id: TARGET_SESSION,
        label: "둘째 웹훅",
        auth_mode: "signature",
      })).json();
      const other = (await issueRequest(app, {
        target_session_id: TARGET_SESSION,
        label: "남의 웹훅",
        auth_mode: "key",
      }, OTHER_EMAIL)).json();
      const link = await repository.issue({
        kind: "link",
        ownerEmail: OWNER_EMAIL,
        label: "같은 주인의 링크",
        targetSessionId: TARGET_SESSION,
        permissions: ["send", "read_own"],
        expiresInSeconds: 3600,
      });
      // Pin the order: list is created_at DESC.
      await harness.sql`
        UPDATE external_access_grants
        SET created_at = CASE id
          WHEN ${first.id}::uuid THEN NOW() - INTERVAL '2 minutes'
          WHEN ${second.id}::uuid THEN NOW() - INTERVAL '1 minute'
          ELSE created_at
        END
        WHERE id IN (${first.id}::uuid, ${second.id}::uuid)
      `;

      const listed = await listRequest(app);
      expect(listed.statusCode).toBe(200);
      expect(listed.headers["cache-control"]).toBe("no-store");
      const items = listed.json() as Array<Record<string, unknown>>;
      expect(items.map((item) => item.id)).toEqual([second.id, first.id]);
      expect(items[0]).toMatchObject({
        label: "둘째 웹훅",
        target_session_id: TARGET_SESSION,
        auth_mode: "signature",
        url: `${PUBLIC_URL.replace(/\/+$/, "")}/api/hooks/${second.id}`,
        state: "active",
        recent: { count_24h: 0, failed_24h: 0, last_received_at: null },
      });

      const serialized = JSON.stringify(items);
      for (const secret of [first.secret, second.secret, other.secret]) {
        expect(serialized).not.toContain(secret);
      }
      expect(serialized).not.toContain("key_hash");
      expect(serialized).not.toContain("signing_secret");
      expect(serialized).not.toContain("ssxw_");
      expect(serialized).not.toContain("whsec_");
      expect(items.map((item) => item.id)).not.toContain(link.grant.id);

      const anonymous = await listRequest(app, null);
      expect(anonymous.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("summarizes the last 24 hours of receives per webhook in one query", async () => {
    const repository = grantRepository();
    const service = new ExternalInputService({
      sql: harness.sql as unknown as SqlClient,
      grants: repository,
      dispatch: async (targetSessionId, body) => {
        dispatched.push({ targetSessionId, body });
      },
    });
    let summarizeCalls = 0;
    const { app } = createManagementApp({
      repository,
      service,
      requests: {
        summarizeGrants: async (grantIds) => {
          summarizeCalls += 1;
          return await service.summarizeGrants(grantIds);
        },
        listRecentRequests: async (grantId, limit) =>
          await service.listRecentRequests(grantId, limit),
      },
    });
    try {
      const target = (await issueRequest(app, {
        target_session_id: TARGET_SESSION,
        label: "요약 대상",
        auth_mode: "key",
      })).json();
      const quiet = (await issueRequest(app, {
        target_session_id: TARGET_SESSION,
        label: "조용한 웹훅",
        auth_mode: "key",
      })).json();

      const first = await receiveKey(app, target.id, target.secret, "{\"text\":\"첫 수신\"}");
      const second = await receiveKey(app, target.id, target.secret, "{\"text\":\"둘째 수신\"}");
      expect(first.statusCode).toBe(202);
      expect(second.statusCode).toBe(202);

      // One of the two receipts fails in the ledger.
      const deliveries = await harness.sql<Array<{ delivery_id: string; request_id: string }>>`
        SELECT receipt.delivery_id, receipt.request_id
        FROM external_input_receipts receipt
        WHERE receipt.grant_id = ${target.id}::uuid
        ORDER BY receipt.created_at DESC
        LIMIT 1
      `;
      await harness.sql`
        UPDATE session_deliveries
        SET state = 'uncertain', aggregate_state = 'dead_letter'
        WHERE delivery_id = ${deliveries[0]!.delivery_id}
      `;

      // A receipt older than the window is neither counted nor the last time.
      await harness.sql`
        INSERT INTO external_input_receipts (
          grant_id, request_id, request_hash, delivery_id,
          target_session_id, payload, caller_info, created_at
        ) VALUES (
          ${target.id}::uuid, 'old-request', ${"c".repeat(64)},
          ${"old-delivery"}, ${TARGET_SESSION},
          ${harness.sql.json({})}, ${harness.sql.json({})},
          NOW() - INTERVAL '25 hours'
        )
      `;

      const newest = await harness.sql<Array<{ at: Date }>>`
        SELECT MAX(created_at) AS at FROM external_input_receipts
        WHERE grant_id = ${target.id}::uuid
          AND request_id <> 'old-request'
      `;

      const listed = await listRequest(app);
      expect(listed.statusCode).toBe(200);
      const byId = new Map(
        (listed.json() as Array<{ id: string; recent: Record<string, unknown> }>)
          .map((item) => [item.id, item.recent]),
      );
      expect(byId.get(target.id)).toEqual({
        count_24h: 2,
        failed_24h: 1,
        last_received_at: newest[0]!.at.toISOString(),
      });
      expect(byId.get(quiet.id)).toEqual({
        count_24h: 0,
        failed_24h: 0,
        last_received_at: null,
      });
      expect(summarizeCalls).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("reports revoked, expired and active states", async () => {
    const { app } = createManagementApp();
    try {
      const active = (await issueRequest(app, {
        target_session_id: TARGET_SESSION,
        label: "활성",
        auth_mode: "key",
      })).json();
      const expiring = (await issueRequest(app, {
        target_session_id: TARGET_SESSION,
        label: "만료",
        auth_mode: "key",
        expires_in_seconds: 3600,
      })).json();
      const revoked = (await issueRequest(app, {
        target_session_id: TARGET_SESSION,
        label: "폐기",
        auth_mode: "key",
      })).json();
      await harness.sql`
        UPDATE external_access_grants SET expires_at = NOW() - INTERVAL '1 minute'
        WHERE id = ${expiring.id}::uuid
      `;
      expect((await deleteRequest(app, revoked.id)).statusCode).toBe(200);

      const listed = await listRequest(app);
      const states = new Map(
        (listed.json() as Array<{ id: string; state: string }>)
          .map((item) => [item.id, item.state]),
      );
      expect(states.get(active.id)).toBe("active");
      expect(states.get(expiring.id)).toBe("expired");
      expect(states.get(revoked.id)).toBe("revoked");
    } finally {
      await app.close();
    }
  });

  it("lists recent requests newest first with the status judgment", async () => {
    const { app } = createManagementApp();
    try {
      const target = (await issueRequest(app, {
        target_session_id: TARGET_SESSION,
        label: "요청 목록",
        auth_mode: "key",
      })).json();

      const older = await receiveKey(app, target.id, target.secret, "{\"text\":\"먼저\"}");
      expect(older.statusCode).toBe(202);
      const newer = await receiveKey(app, target.id, target.secret, "{\"text\":\"나중\"}");
      expect(newer.statusCode).toBe(202);
      await harness.sql`
        UPDATE external_input_receipts
        SET created_at = CASE request_id
          WHEN ${older.json().request_id} THEN NOW() - INTERVAL '2 minutes'
          WHEN ${newer.json().request_id} THEN NOW() - INTERVAL '1 minute'
          ELSE created_at
        END
        WHERE grant_id = ${target.id}::uuid
      `;
      const reply = await writeExternalReply(harness.sql as unknown as SqlClient, {
        callerSessionId: TARGET_SESSION,
        requestHandle: `${target.id}:${newer.json().request_id}`,
        text: "처리했습니다",
        final: true,
      });
      expect(reply.ok).toBe(true);

      const listed = await requestsRequest(app, target.id);
      expect(listed.statusCode).toBe(200);
      expect(listed.headers["cache-control"]).toBe("no-store");
      const items = (listed.json() as {
        items: Array<Record<string, unknown>>;
      }).items;
      expect(items.map((item) => item.request_id)).toEqual([
        newer.json().request_id,
        older.json().request_id,
      ]);
      expect(items[0]).toMatchObject({
        request_id: newer.json().request_id,
        status: "completed",
        outcome: "replied",
        session: { state: "running" },
      });
      expect(items[0]!.replies).toEqual([
        { id: expect.any(String), text: "처리했습니다", at: expect.any(String) },
      ]);
      expect(typeof items[0]!.received_at).toBe("string");
      expect(items[1]).toMatchObject({
        request_id: older.json().request_id,
        status: "accepted",
        replies: [],
      });

      const limited = await requestsRequest(app, target.id, { limit: "1" });
      expect((limited.json() as { items: unknown[] }).items).toHaveLength(1);
      const notANumber = await requestsRequest(app, target.id, { limit: "abc" });
      expect(notANumber.statusCode).toBe(422);
      const zero = await requestsRequest(app, target.id, { limit: "0" });
      expect(zero.statusCode).toBe(422);
      const fiftyOne = await requestsRequest(app, target.id, { limit: "51" });
      expect(fiftyOne.statusCode).toBe(422);

      const otherWebhook = (await issueRequest(app, {
        target_session_id: TARGET_SESSION,
        label: "남의 웹훅",
        auth_mode: "key",
      }, OTHER_EMAIL)).json();
      const other = await requestsRequest(app, otherWebhook.id);
      const unknown = await requestsRequest(app, "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f");
      const notUuid = await requestsRequest(app, "not-a-uuid");
      expect(notUuid.statusCode).toBe(422);
      expect(other.statusCode).toBe(404);
      expect(unknown.statusCode).toBe(404);
      expect(other.json()).toEqual(unknown.json());
      expect(other.json()).toEqual({ detail: "Inbound webhook not found" });

      const linkGrant = await grantRepository().issue({
        kind: "link",
        ownerEmail: OWNER_EMAIL,
        label: "링크",
        targetSessionId: TARGET_SESSION,
        permissions: ["send", "read_own"],
        expiresInSeconds: 3600,
      });
      const linkRequests = await requestsRequest(app, linkGrant.grant.id);
      expect(linkRequests.statusCode).toBe(404);
      expect(linkRequests.json()).toEqual({ detail: "Inbound webhook not found" });

      expect((await deleteRequest(app, target.id)).statusCode).toBe(200);
      const afterRevoke = await requestsRequest(app, target.id);
      expect(afterRevoke.statusCode).toBe(200);
      expect((afterRevoke.json() as { items: unknown[] }).items).toHaveLength(2);

      const anonymous = await requestsRequest(app, target.id, { email: null });
      expect(anonymous.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("revokes only the caller's own inbound webhook and keeps other grants", async () => {
    const { app, repository } = createManagementApp();
    try {
      const mine = (await issueRequest(app, {
        target_session_id: TARGET_SESSION,
        label: "내 웹훅",
        auth_mode: "key",
      })).json();
      const received = await receiveKey(app, mine.id, mine.secret, "{\"text\":\"폐기 전\"}");
      expect(received.statusCode).toBe(202);

      const revoked = await deleteRequest(app, mine.id);
      expect(revoked.statusCode).toBe(200);
      expect(revoked.headers["cache-control"]).toBe("no-store");
      expect(revoked.json()).toMatchObject({
        id: mine.id,
        revoked_at: expect.any(String),
        state: "revoked",
      });

      const afterRevoke = await receiveKey(app, mine.id, mine.secret, "{\"text\":\"폐기 뒤\"}");
      expect(afterRevoke.statusCode).toBe(401);
      expect((await deleteRequest(app, mine.id)).statusCode).toBe(404);

      const link = await repository.issue({
        kind: "link",
        ownerEmail: OWNER_EMAIL,
        label: "링크",
        targetSessionId: TARGET_SESSION,
        permissions: ["send", "read_own"],
        expiresInSeconds: 3600,
      });
      const linkDelete = await deleteRequest(app, link.grant.id);
      expect(linkDelete.statusCode).toBe(404);
      expect((await repository.resolveGrant(link.key, "send")).ok).toBe(true);
      const linkRow = (await grantRows()).find((row) => row.id === link.grant.id);
      expect(linkRow?.revoked_at).toBeNull();

      const theirs = (await issueRequest(app, {
        target_session_id: TARGET_SESSION,
        label: "남의 웹훅",
        auth_mode: "key",
      }, OTHER_EMAIL)).json();
      expect((await deleteRequest(app, theirs.id)).statusCode).toBe(404);
      const theirRow = (await grantRows()).find((row) => row.id === theirs.id);
      expect(theirRow?.revoked_at).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("answers storage failures with 503 and logs only a safe classification", async () => {
    const secret = "whsec_leaked_secret_value";
    const logged: string[] = [];
    const failure = Object.assign(
      new Error(`insert failed near ${secret}`),
      {
        code: "23505",
        constraint: "external_access_grants_pkey",
        detail: `detail with ${secret}`,
      },
    );
    const failingRequests: InboundWebhookRouteOptions["requests"] = {
      summarizeGrants: async () => {
        throw failure;
      },
      listRecentRequests: async () => {
        throw failure;
      },
    };
    const { app } = createManagementApp({
      requests: failingRequests,
      logger: {
        warn: (fields, message) => {
          logged.push(`${message} ${JSON.stringify(fields)}`);
        },
      },
    });
    try {
      const issued = (await issueRequest(app, {
        target_session_id: TARGET_SESSION,
        label: "실패 로그",
        auth_mode: "signature",
      })).json();

      const listed = await listRequest(app);
      expect(listed.statusCode).toBe(503);
      expect(listed.headers["cache-control"]).toBe("no-store");
      expect(listed.json()).toEqual({
        detail: "Inbound webhook storage temporarily unavailable",
      });
      const requests = await requestsRequest(app, issued.id);
      expect(requests.statusCode).toBe(503);
      expect(requests.json()).toEqual({
        detail: "Inbound webhook storage temporarily unavailable",
      });

      expect(logged.length).toBeGreaterThan(0);
      const combined = logged.join("\n");
      expect(combined).toContain("23505");
      expect(combined).toContain("external_access_grants_pkey");
      expect(combined).not.toContain(secret);
      expect(combined).not.toContain(issued.secret);
      expect(combined).not.toContain("insert failed");
      expect(combined).not.toContain("detail with");
    } finally {
      await app.close();
    }
  });

  it("keeps list and revoke without a kind unchanged for links and webhooks", async () => {
    const repository = grantRepository();
    const webhook = await repository.issueInboundWebhook({
      ownerEmail: OWNER_EMAIL,
      label: "웹훅",
      targetSessionId: TARGET_SESSION,
      authMode: "key",
    });
    const link = await repository.issue({
      kind: "link",
      ownerEmail: OWNER_EMAIL,
      label: "링크",
      targetSessionId: TARGET_SESSION,
      permissions: ["send", "read_own"],
      expiresInSeconds: 3600,
    });

    const all = await repository.list(OWNER_EMAIL);
    expect(all.map((grant) => grant.id).sort()).toEqual(
      [webhook.grant.id, link.grant.id].sort(),
    );
    expect((await repository.list(OWNER_EMAIL, "link")).map((grant) => grant.id))
      .toEqual([link.grant.id]);
    expect((await repository.list(OWNER_EMAIL, "inbound_webhook")).map((grant) => grant.id))
      .toEqual([webhook.grant.id]);

    const wrongKind = await repository.revoke(OWNER_EMAIL, link.grant.id, "inbound_webhook");
    expect(wrongKind).toBeNull();
    expect((await repository.resolveGrant(link.key, "send")).ok).toBe(true);

    const revokedLink = await repository.revoke(OWNER_EMAIL, link.grant.id);
    expect(revokedLink?.kind).toBe("link");
    const revokedWebhook = await repository.revoke(OWNER_EMAIL, webhook.grant.id);
    expect(revokedWebhook?.kind).toBe("inbound_webhook");

    const found = await repository.findOwned(
      OWNER_EMAIL,
      webhook.grant.id,
      "inbound_webhook",
    );
    expect(found?.id).toBe(webhook.grant.id);
    expect(found?.revoked_at).not.toBeNull();
    expect(found).not.toHaveProperty("key_hash");
    expect(found).not.toHaveProperty("signing_secret");
    expect(await repository.findOwned(OWNER_EMAIL, webhook.grant.id, "link")).toBeNull();
    expect(await repository.findOwned(OTHER_EMAIL, webhook.grant.id, "inbound_webhook"))
      .toBeNull();
  });
});
