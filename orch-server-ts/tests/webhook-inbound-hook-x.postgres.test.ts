/**
 * card #1458 — the header-less key receive surface `POST /x/<key>/hook` against
 * real Postgres: the real grant repository judges the URL key, the real
 * ExternalInputService writes receipts and the ledger, and only the session
 * dispatch is fake. The management routes and both receive routes share one
 * app, so the issued `key_url` is followed to a real admission.
 */
import { readFile } from "node:fs/promises";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { parseOrchServerConfig } from "../src/config.js";
import type { SqlClient } from "../src/control_plane/control_plane_types.js";
import {
  ExternalAccessGrantRepository,
} from "../src/external_access/external_access_grant_repository.js";
import { ExternalInputService } from "../src/external_access/external_input_service.js";
import { SessionResourceAccessError } from "../src/session/session_resource_access.js";
import { createPagePostgresHarness, type PagePostgresHarness } from
  "./page/page_postgres_harness.js";

const OWNER_EMAIL = "owner@example.com";
const PUBLIC_URL = "https://soulstream.example.test/";
const PUBLIC_ORIGIN = PUBLIC_URL.replace(/\/+$/, "");
const TARGET_SESSION = "0f6d8c2a-4b31-4d7e-9a15-9c8b7a6d5e4f";
const PREAMBLE = "빌드 결과 자료입니다";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

const UNAUTHORIZED_BODY = {
  error: { code: "unauthorized", message: "Unauthorized" },
};

function extractSchemaBlock(schemaSql: string, pattern: RegExp): string {
  const match = schemaSql.match(pattern);
  if (match === null) throw new Error(`schema block not found: ${pattern}`);
  return match[0];
}

interface Dispatched {
  targetSessionId: string;
  body: Record<string, unknown>;
}

describe("header-less inbound webhook receive", () => {
  let harness: PagePostgresHarness;
  let dispatched: Dispatched[];

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
      INSERT INTO users (email, display_name) VALUES (${OWNER_EMAIL}, '테스트 사용자')
    `;
    await harness.sql`
      INSERT INTO sessions (session_id, status) VALUES (${TARGET_SESSION}, 'running')
    `;
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  function grantRepository(): ExternalAccessGrantRepository {
    return new ExternalAccessGrantRepository({
      sql: harness.sql as unknown as SqlClient,
      authorizeUser: async () => null,
      requireSessionAccess: async (input) => {
        if (input.sessionId !== TARGET_SESSION) {
          throw new SessionResourceAccessError(
            "SESSION_NOT_FOUND",
            "Session not found",
            404,
          );
        }
      },
    });
  }

  function createWebhookApp(
    repository: ExternalAccessGrantRepository = grantRepository(),
  ) {
    const service = new ExternalInputService({
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
        requests: service,
        requireSessionAccess: async (input) => {
          if (input.sessionId !== TARGET_SESSION) {
            throw new SessionResourceAccessError(
              "SESSION_NOT_FOUND",
              "Session not found",
              404,
            );
          }
        },
        publicUrl: PUBLIC_URL,
      },
    });
    return { app, repository, service };
  }

  async function issue(
    app: ReturnType<typeof createApp>,
    payload: Record<string, unknown>,
  ) {
    return await app.inject({
      method: "POST",
      url: "/api/webhooks/inbound",
      headers: { "x-user-email": OWNER_EMAIL },
      payload,
    });
  }

  async function issueKey(
    app: ReturnType<typeof createApp>,
    overrides: Record<string, unknown> = {},
  ) {
    const response = await issue(app, {
      target_session_id: TARGET_SESSION,
      label: "빌드 알림",
      auth_mode: "key",
      ...overrides,
    });
    expect(response.statusCode).toBe(201);
    return response.json() as {
      id: string;
      url: string;
      key_url?: string;
      secret: string;
    };
  }

  function hookPath(secret: string): string {
    return `/x/${secret}/hook`;
  }

  async function postHook(
    app: ReturnType<typeof createApp>,
    secret: string,
    payload: string | Buffer | undefined,
    headers: Record<string, string> = {},
  ) {
    return await app.inject({
      method: "POST",
      url: hookPath(secret),
      ...(payload === undefined ? {} : { payload }),
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
    });
  }

  async function receiptRows() {
    return await harness.sql<Array<{
      grant_id: string;
      request_id: string;
      payload: { text: string };
      request_hash: string;
    }>>`SELECT grant_id, request_id, payload, request_hash FROM external_input_receipts`;
  }

  it("issues key_url only for key webhooks and never lists key material", async () => {
    const { app } = createWebhookApp();
    try {
      const key = await issueKey(app, { preamble: PREAMBLE });
      expect(key.key_url).toBe(`${PUBLIC_ORIGIN}/x/${key.secret}/hook`);
      expect(key.key_url?.startsWith(PUBLIC_ORIGIN)).toBe(true);
      expect(key.key_url?.endsWith(hookPath(key.secret))).toBe(true);

      const signature = await issue(app, {
        target_session_id: TARGET_SESSION,
        label: "서명 웹훅",
        auth_mode: "signature",
      });
      expect(signature.statusCode).toBe(201);
      const signatureBody = signature.json() as Record<string, unknown>;
      expect(signatureBody).not.toHaveProperty("key_url");
      expect(signatureBody).not.toHaveProperty("key");

      const listed = await app.inject({
        method: "GET",
        url: "/api/webhooks/inbound",
        headers: { "x-user-email": OWNER_EMAIL },
      });
      expect(listed.statusCode).toBe(200);
      const serialized = JSON.stringify(listed.json());
      expect(serialized).not.toContain("ssxw_");
      expect(serialized).not.toContain("key_url");
      expect(serialized).not.toContain(key.secret);
      expect(serialized).not.toContain(signatureBody.secret as string);
    } finally {
      await app.close();
    }
  });

  it("admits a JSON text body through the issued key_url", async () => {
    const { app } = createWebhookApp();
    try {
      const key = await issueKey(app, { preamble: PREAMBLE });
      const response = await postHook(app, key.secret, "{\"text\":\"빌드 성공\"}", {
        "content-type": "application/json",
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({ status: "accepted" });
      expect(typeof response.json().request_id).toBe("string");
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]!.targetSessionId).toBe(TARGET_SESSION);
      expect(dispatched[0]!.body.text).toBe(`${PREAMBLE}\n\n빌드 성공`);

      const receipts = await receiptRows();
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({ grant_id: key.id });
      expect(receipts[0]!.payload.text).toBe(`${PREAMBLE}\n\n빌드 성공`);
    } finally {
      await app.close();
    }
  });

  it("keeps the received bytes for every non-JSON content type", async () => {
    const { app } = createWebhookApp();
    try {
      const key = await issueKey(app, { preamble: PREAMBLE });

      const withoutType = await postHook(app, key.secret, "타입 없는 본문");
      expect(withoutType.statusCode).toBe(202);

      const plain = await postHook(app, key.secret, "그냥 글 본문", {
        "content-type": "text/plain",
      });
      expect(plain.statusCode).toBe(202);

      const form = await postHook(app, key.secret, "a=1&b=2", {
        "content-type": "application/x-www-form-urlencoded",
      });
      expect(form.statusCode).toBe(202);

      expect(dispatched.map((item) => item.body.text)).toEqual([
        `${PREAMBLE}\n\n타입 없는 본문`,
        `${PREAMBLE}\n\n그냥 글 본문`,
        `${PREAMBLE}\n\na=1&b=2`,
      ]);
    } finally {
      await app.close();
    }
  });

  it("replays one admission for the same webhook-id and answers 409 for other bytes", async () => {
    const { app } = createWebhookApp();
    try {
      const key = await issueKey(app, { preamble: PREAMBLE });
      const body = "{\"text\":\"같은 요청\"}";

      const first = await postHook(app, key.secret, body, { "webhook-id": "wh_same" });
      const second = await postHook(app, key.secret, body, { "webhook-id": "wh_same" });
      expect(first.statusCode).toBe(202);
      expect(second.statusCode).toBe(202);
      expect(second.json()).toEqual(first.json());
      // A retransmission re-enters admit but resolves to the stored receipt
      // and the same delivery identity, exactly like `/api/hooks`: the target
      // session input exists once (one receipt, one ledger row). The session
      // dispatch is counted per delivery identity, not per HTTP call.
      expect(new Set(dispatched.map((item) => item.body.delivery_id)).size).toBe(1);
      const deliveries = await harness.sql`SELECT 1 FROM session_deliveries`;
      expect(deliveries).toHaveLength(1);

      let receipts = await receiptRows();
      expect(receipts).toHaveLength(1);
      expect(receipts[0]!.request_id).toBe("wh_same");

      const conflict = await postHook(app, key.secret, "{\"text\":\"다른 바이트\"}", {
        "webhook-id": "wh_same",
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toEqual({
        error: { code: "conflict", message: expect.any(String) },
      });
      receipts = await receiptRows();
      expect(receipts).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("rejects a body over 256KiB with the shared 413", async () => {
    const { app } = createWebhookApp();
    try {
      const key = await issueKey(app, { preamble: PREAMBLE });
      const tooLarge = await postHook(app, key.secret, Buffer.alloc(300 * 1024, 0x61));
      expect(tooLarge.statusCode).toBe(413);
      expect(tooLarge.json()).toEqual({
        error: { code: "payload_too_large", message: expect.any(String) },
      });
      expect(dispatched).toHaveLength(0);
      expect(await receiptRows()).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("answers every unusable URL key with the same 401 and no receipt", async () => {
    const { app, repository } = createWebhookApp();
    try {
      const key = await issueKey(app, { preamble: PREAMBLE });
      const link = await repository.issue({
        kind: "link",
        ownerEmail: OWNER_EMAIL,
        label: "링크",
        targetSessionId: TARGET_SESSION,
        permissions: ["send", "read_own"],
        expiresInSeconds: 3600,
      });
      const revoked = await repository.issueInboundWebhook({
        ownerEmail: OWNER_EMAIL,
        label: "폐기 웹훅",
        targetSessionId: TARGET_SESSION,
        authMode: "key",
      });
      await repository.revoke(OWNER_EMAIL, revoked.grant.id, "inbound_webhook");
      const expired = await repository.issueInboundWebhook({
        ownerEmail: OWNER_EMAIL,
        label: "만료 웹훅",
        targetSessionId: TARGET_SESSION,
        authMode: "key",
        expiresInSeconds: 3600,
      });
      await harness.sql`
        UPDATE external_access_grants SET expires_at = NOW() - INTERVAL '1 minute'
        WHERE id = ${expired.grant.id}
      `;
      const changedSecret = `${key.secret.slice(0, -1)}${key.secret.endsWith("A") ? "B" : "A"}`;
      const body = "{\"text\":\"거절\"}";

      const cases: Array<{ name: string; secret: string; headers?: Record<string, string> }> = [
        { name: "link key", secret: link.key },
        { name: "unparseable key", secret: "not-a-key" },
        { name: "changed secret", secret: changedSecret },
        { name: "revoked webhook", secret: revoked.secret },
        { name: "expired webhook", secret: expired.secret },
        {
          name: "correct bearer with a wrong URL key",
          secret: changedSecret,
          headers: { authorization: `Bearer ${key.secret}` },
        },
      ];

      const responses = [];
      for (const testCase of cases) {
        responses.push({
          name: testCase.name,
          response: await postHook(app, testCase.secret, body, testCase.headers ?? {}),
        });
      }
      for (const testCase of responses) {
        expect(testCase.response.statusCode, testCase.name).toBe(401);
        expect(testCase.response.json(), testCase.name).toEqual(UNAUTHORIZED_BODY);
      }
      expect(dispatched).toHaveLength(0);
      expect(await receiptRows()).toHaveLength(0);

      // The same key still works while it is unrevoked and unexpired.
      const accepted = await postHook(app, key.secret, body);
      expect(accepted.statusCode).toBe(202);
    } finally {
      await app.close();
    }
  });

  it("shows the request through the management list and the bearer status read", async () => {
    const { app } = createWebhookApp();
    try {
      const key = await issueKey(app, { preamble: PREAMBLE });
      const admitted = await postHook(app, key.secret, "{\"text\":\"상태 확인\"}", {
        "webhook-id": "wh_hook_x_status",
      });
      expect(admitted.statusCode).toBe(202);

      const listed = await app.inject({
        method: "GET",
        url: `/api/webhooks/inbound/${key.id}/requests`,
        headers: { "x-user-email": OWNER_EMAIL },
      });
      expect(listed.statusCode).toBe(200);
      const items = (listed.json() as { items: Array<Record<string, unknown>> }).items;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        request_id: "wh_hook_x_status",
        status: "accepted",
        received_at: expect.any(String),
      });

      const status = await app.inject({
        method: "GET",
        url: `/api/hooks/${key.id}/requests/wh_hook_x_status`,
        headers: { authorization: `Bearer ${key.secret}` },
      });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({
        request_id: "wh_hook_x_status",
        status: "accepted",
      });
    } finally {
      await app.close();
    }
  });

  it("answers 202 and 401 with no-store and no-referrer headers", async () => {
    const { app } = createWebhookApp();
    try {
      const key = await issueKey(app, { preamble: PREAMBLE });
      const accepted = await postHook(app, key.secret, "{\"text\":\"헤더\"}");
      expect(accepted.statusCode).toBe(202);
      expect(accepted.headers["cache-control"]).toBe("no-store");
      expect(accepted.headers["referrer-policy"]).toBe("no-referrer");

      const rejected = await postHook(app, "not-a-key", "{\"text\":\"헤더\"}");
      expect(rejected.statusCode).toBe(401);
      expect(rejected.headers["cache-control"]).toBe("no-store");
      expect(rejected.headers["referrer-policy"]).toBe("no-referrer");
    } finally {
      await app.close();
    }
  });
});
