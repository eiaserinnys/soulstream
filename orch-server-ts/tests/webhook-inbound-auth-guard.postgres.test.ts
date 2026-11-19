/**
 * card #1458 — production auth guard composition. The app is built the way
 * production builds it (createApp with productionAuth, so the real
 * registerProductionAuthGuard hook runs) and registers both the receive routes
 * and the management routes. A webhook credential must pass the guard and reach
 * the route (202/200 or the route's own {error:{code}} body), while the
 * management routes without login get the guard's {detail} 401.
 *
 * nodeCredentials is the production resolver itself (NodeCredentialStore over
 * SqlNodeCredentialRepository), loaded from the test database: no network.
 */
import { readFile } from "node:fs/promises";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { parseOrchServerConfig } from "../src/config.js";
import type { SqlClient } from "../src/control_plane/control_plane_types.js";
import { ExternalAccessGrantRepository } from
  "../src/external_access/external_access_grant_repository.js";
import { ExternalInputService } from "../src/external_access/external_input_service.js";
import { hashToken, NodeCredentialStore } from
  "../src/node_credentials/credential_store.js";
import { SqlNodeCredentialRepository } from
  "../src/node_credentials/credential_repository.js";
import { standardWebhookHeaders } from "../src/webhooks/standard_webhook_signature.js";
import { createPagePostgresHarness, type PagePostgresHarness } from
  "./page/page_postgres_harness.js";

const OWNER_EMAIL = "owner@example.com";
const PUBLIC_URL = "https://soulstream.example.test";
const TARGET_SESSION = "inbound-guard-target";
const NODE_TOKEN = "node-token";
const NODE_CREDENTIAL_ID = "5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c";
const GUARD_DETAIL = "Authorization header required";

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

describe("inbound webhook routes behind the production auth guard", () => {
  let harness: PagePostgresHarness;
  let nodeCredentials: NodeCredentialStore;
  let dispatched: number;

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
    await harness.sql.unsafe(extractSchemaBlock(
      schemaSql,
      /CREATE TABLE IF NOT EXISTS node_credentials \([\s\S]*?\n\);/,
    ));
    await harness.sql.unsafe(
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS termination_event_id INTEGER`,
    );

    nodeCredentials = new NodeCredentialStore({
      repository: new SqlNodeCredentialRepository(async () => harness.liveSql),
    });
  }, 60_000);

  beforeEach(async () => {
    dispatched = 0;
    await harness.sql`DELETE FROM session_delivery_attempts`;
    await harness.sql`DELETE FROM session_delivery_relation_consumptions`;
    await harness.sql`DELETE FROM session_deliveries`;
    await harness.sql`DELETE FROM external_replies`;
    await harness.sql`DELETE FROM external_input_receipts`;
    await harness.sql`DELETE FROM external_access_grants`;
    await harness.sql`DELETE FROM sessions`;
    await harness.sql`DELETE FROM users`;
    await harness.sql`DELETE FROM node_credentials`;
    await harness.sql`
      INSERT INTO users (email, display_name) VALUES (${OWNER_EMAIL}, '테스트 사용자')
    `;
    await harness.sql`
      INSERT INTO sessions (session_id, status) VALUES (${TARGET_SESSION}, 'running')
    `;
    await harness.sql`
      INSERT INTO node_credentials (credential_id, node_id, company_pc, token_sha256)
      VALUES (${NODE_CREDENTIAL_ID}, 'fake-node', false, ${hashToken(NODE_TOKEN)})
    `;
    const initialized = await nodeCredentials.initialize();
    expect(initialized.ok).toBe(true);
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  function grantRepository(): ExternalAccessGrantRepository {
    return new ExternalAccessGrantRepository({
      sql: harness.sql as unknown as SqlClient,
      authorizeUser: async () => null,
      requireSessionAccess: async () => {},
    });
  }

  function createGuardedApp(
    overrides: {
      config?: ReturnType<typeof parseOrchServerConfig>;
      logDestination?: { write(message: string): void };
      corsAllowedOrigins?: string[];
    } = {},
  ) {
    const repository = grantRepository();
    const service = new ExternalInputService({
      sql: harness.sql as unknown as SqlClient,
      grants: repository,
      dispatch: async () => {
        dispatched += 1;
      },
    });
    const app = createApp({
      config: overrides.config ?? config,
      ...(overrides.logDestination === undefined
        ? {}
        : { logDestination: overrides.logDestination }),
      ...(overrides.corsAllowedOrigins === undefined
        ? {}
        : { corsAllowedOrigins: overrides.corsAllowedOrigins }),
      // The production shape: no user token ever resolves, and node credentials
      // are the real resolver loaded from the database.
      productionAuth: {
        resolveTokenAccess: async () => ({
          ok: false as const,
          statusCode: 401,
          detail: GUARD_DETAIL,
        }),
        nodeCredentials,
      },
      inboundHookRoutes: { grants: repository, service },
      inboundWebhookRoutes: {
        currentEmail: async () => null,
        grants: repository,
        requests: service,
        requireSessionAccess: async () => {},
        publicUrl: PUBLIC_URL,
      },
    });
    return { app, repository };
  }

  async function issueKeyGrant(repository: ExternalAccessGrantRepository) {
    return await repository.issueInboundWebhook({
      ownerEmail: OWNER_EMAIL,
      label: "가드 확인",
      targetSessionId: TARGET_SESSION,
      authMode: "key",
    });
  }

  async function issueSignatureGrant(repository: ExternalAccessGrantRepository) {
    return await repository.issueInboundWebhook({
      ownerEmail: OWNER_EMAIL,
      label: "가드 서명 확인",
      targetSessionId: TARGET_SESSION,
      authMode: "signature",
    });
  }

  it("passes bearer-key POSTs through the guard with and without a content type", async () => {
    const { app, repository } = createGuardedApp();
    try {
      const grant = await issueKeyGrant(repository);

      const withType = await app.inject({
        method: "POST",
        url: `/api/hooks/${grant.grant.id}`,
        payload: "{\"text\":\"가드 통과\"}",
        headers: {
          authorization: `Bearer ${grant.secret}`,
          "content-type": "application/json",
        },
      });
      expect(withType.statusCode).toBe(202);
      expect(withType.json()).toEqual({
        request_id: expect.any(String),
        status: "accepted",
      });
      expect(withType.json()).not.toHaveProperty("detail");

      const withoutType = await app.inject({
        method: "POST",
        url: `/api/hooks/${grant.grant.id}`,
        payload: Buffer.from("{\"text\":\"타입 없이\"}", "utf8"),
        headers: { authorization: `Bearer ${grant.secret}` },
      });
      expect(withoutType.statusCode).toBe(202);
      expect(withoutType.json()).toMatchObject({ status: "accepted" });
      expect(withoutType.json()).not.toHaveProperty("detail");

      expect(dispatched).toBe(2);
    } finally {
      await app.close();
    }
  });

  it("passes signed POSTs and signed status reads through the guard", async () => {
    const { app, repository } = createGuardedApp();
    try {
      const grant = await issueSignatureGrant(repository);
      const body = "{\"text\":\"서명 가드\"}";
      const signed = await app.inject({
        method: "POST",
        url: `/api/hooks/${grant.grant.id}`,
        payload: body,
        headers: standardWebhookHeaders({
          secret: grant.secret,
          webhookId: "wh_guard",
          body,
        }),
      });
      expect(signed.statusCode).toBe(202);
      const admitted = signed.json() as { request_id: string; status: string };
      expect(admitted).toEqual({ request_id: "wh_guard", status: "accepted" });

      const status = await app.inject({
        method: "GET",
        url: `/api/hooks/${grant.grant.id}/requests/${admitted.request_id}`,
        headers: standardWebhookHeaders({
          secret: grant.secret,
          webhookId: "wh_guard_read",
          body: "",
        }),
      });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({
        request_id: "wh_guard",
        status: "accepted",
      });
      expect(status.json()).not.toHaveProperty("detail");
    } finally {
      await app.close();
    }
  });

  it("answers the guard's 401 on all four management routes without login", async () => {
    const { app } = createGuardedApp();
    try {
      const responses = await Promise.all([
        app.inject({
          method: "POST",
          url: "/api/webhooks/inbound",
          payload: {
            target_session_id: TARGET_SESSION,
            label: "가드",
            auth_mode: "key",
          },
        }),
        app.inject({ method: "GET", url: "/api/webhooks/inbound" }),
        app.inject({
          method: "GET",
          url: "/api/webhooks/inbound/00000000-0000-4000-8000-000000000000/requests",
        }),
        app.inject({
          method: "DELETE",
          url: "/api/webhooks/inbound/00000000-0000-4000-8000-000000000000",
        }),
      ]);

      for (const response of responses) {
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({ detail: GUARD_DETAIL });
      }
      // Nothing reached the storage: no grant was issued.
      const rows = await harness.sql`SELECT 1 FROM external_access_grants`;
      expect(rows).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("passes key-URL POSTs through the guard and keeps the key out of the logs", async () => {
    const capture = createLogCapture();
    const { app, repository } = createGuardedApp({
      // Production logging and the production guard together: this is the
      // composition the deployed process runs.
      config: parseOrchServerConfig({
        environment: "production",
        databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
        authBearerToken: "production-service-token",
      }),
      logDestination: capture.stream,
      corsAllowedOrigins: ["https://app.example.test"],
    });
    try {
      const grant = await issueKeyGrant(repository);

      const accepted = await app.inject({
        method: "POST",
        url: `/x/${grant.secret}/hook`,
        payload: "{\"text\":\"가드 통과\"}",
        headers: { "content-type": "application/json" },
      });
      expect(accepted.statusCode).toBe(202);
      expect(accepted.json()).toMatchObject({ status: "accepted" });
      expect(accepted.json()).not.toHaveProperty("detail");
      expect(
        Object.keys(accepted.headers)
          .filter((header) => header.toLowerCase().startsWith("access-control-")),
      ).toEqual([]);
      expect(accepted.headers["referrer-policy"]).toBe("no-referrer");

      const wrong = await app.inject({
        method: "POST",
        url: "/x/not-a-key/hook",
        payload: "{\"text\":\"틀린 키\"}",
      });
      expect(wrong.statusCode).toBe(401);
      // The route's body, not the guard's `{detail}`.
      expect(wrong.json()).toEqual({
        error: { code: "unauthorized", message: "Unauthorized" },
      });
      expect(wrong.json()).not.toHaveProperty("detail");

      expect(dispatched).toBe(1);

      const raw = capture.raw();
      const secretPart = grant.secret.slice(28);
      expect(secretPart).toHaveLength(43);
      expect(raw).not.toContain(grant.secret);
      expect(raw).not.toContain(secretPart);
      const records = capture.records();
      expect(records.some((record) => record.path === "/x/:key/hook")).toBe(true);
      for (const record of records) {
        expect(JSON.stringify(record)).not.toContain(grant.secret);
      }
    } finally {
      await app.close();
    }
  });
});

function createLogCapture() {
  const chunks: string[] = [];
  return {
    stream: {
      write(message: string) {
        chunks.push(message);
      },
    },
    raw: () => chunks.join(""),
    records: (): Array<Record<string, unknown>> => chunks.join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}
