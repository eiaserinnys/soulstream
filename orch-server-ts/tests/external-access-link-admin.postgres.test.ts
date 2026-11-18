/**
 * card #1457 — the access link management API. A signed-in user issues an
 * expiring link, lists their own links without key material, and revokes one.
 * The issuer must be able to reach the target session under the same judgment
 * `resolveGrant` uses: a service caller with the login email as access email.
 */
import { readFile } from "node:fs/promises";

import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { SERVICE_CALLER } from "../src/auth/service_caller.js";
import type { SqlClient } from "../src/control_plane/control_plane_types.js";
import {
  registerAccessLinkRoutes,
  type AccessLinkRouteOptions,
} from "../src/external_access/access_link_routes.js";
import {
  ExternalAccessGrantRepository,
  hashExternalAccessKey,
} from "../src/external_access/external_access_grant_repository.js";
import { SessionResourceAccessError } from
  "../src/session/session_resource_access.js";
import { createPagePostgresHarness, type PagePostgresHarness } from
  "./page/page_postgres_harness.js";

const OWNER_EMAIL = "owner@example.com";
const OTHER_EMAIL = "other@example.com";
const PUBLIC_URL = "https://soulstream.example.test/";
const TARGET_SESSION = "0f6d8c2a-4b31-4d7e-9a15-9c8b7a6d5e4f";
const DENIED_SESSION = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const MISSING_SESSION = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";

function extractSchemaBlock(schemaSql: string, pattern: RegExp): string {
  const match = schemaSql.match(pattern);
  if (match === null) throw new Error(`schema block not found: ${pattern}`);
  return match[0];
}

describe("access link management routes", () => {
  let harness: PagePostgresHarness;

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
  }, 60_000);

  beforeEach(async () => {
    await harness.sql`DELETE FROM external_access_grants`;
    await harness.sql`DELETE FROM sessions`;
    await harness.sql`DELETE FROM users`;
    await harness.sql`
      INSERT INTO users (email, display_name) VALUES
        (${OWNER_EMAIL}, '링크 발급자'), (${OTHER_EMAIL}, '다른 사용자')
    `;
    await harness.sql`
      INSERT INTO sessions (session_id, status) VALUES (${TARGET_SESSION}, 'running')
    `;
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  function createRouteApp(): {
    app: FastifyInstance;
    repository: ExternalAccessGrantRepository;
    accessCalls: Array<{
      request: unknown;
      sessionId: string;
      accessEmail?: string | null;
    }>;
  } {
    const accessCalls: Array<{
      request: unknown;
      sessionId: string;
      accessEmail?: string | null;
    }> = [];
    const judgeSessionAccess = async (sessionId: string): Promise<void> => {
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
    };
    const routeRequireSessionAccess: AccessLinkRouteOptions["requireSessionAccess"] =
      async (input) => {
        accessCalls.push(input);
        await judgeSessionAccess(input.sessionId);
      };
    const repository = new ExternalAccessGrantRepository({
      sql: harness.sql as unknown as SqlClient,
      authorizeUser: async () => null,
      requireSessionAccess: async (input) =>
        await judgeSessionAccess(input.sessionId),
    });
    const app = Fastify();
    registerAccessLinkRoutes(app, {
      currentEmail: (request) => {
        const header = request.headers["x-user-email"];
        return typeof header === "string" && header.length > 0 ? header : null;
      },
      grants: repository,
      requireSessionAccess: routeRequireSessionAccess,
      publicUrl: PUBLIC_URL,
    });
    return { app, repository, accessCalls };
  }

  function issue(
    app: FastifyInstance,
    payload: Record<string, unknown>,
    email: string | null = OWNER_EMAIL,
  ) {
    return app.inject({
      method: "POST",
      url: "/api/access-links",
      headers: email === null ? {} : { "x-user-email": email },
      payload,
    });
  }

  function list(app: FastifyInstance, email: string | null = OWNER_EMAIL) {
    return app.inject({
      method: "GET",
      url: "/api/access-links",
      headers: email === null ? {} : { "x-user-email": email },
    });
  }

  function remove(
    app: FastifyInstance,
    id: string,
    email: string | null = OWNER_EMAIL,
  ) {
    return app.inject({
      method: "DELETE",
      url: `/api/access-links/${id}`,
      headers: email === null ? {} : { "x-user-email": email },
    });
  }

  async function grantRows(): Promise<
    Array<{ id: string; owner_email: string; revoked_at: Date | null }>
  > {
    return await harness.sql<
      Array<{ id: string; owner_email: string; revoked_at: Date | null }>
    >`
      SELECT id, owner_email, revoked_at FROM external_access_grants
    `;
  }

  it("issues a link once, lists it without key material, and the key resolves", async () => {
    const { app, repository, accessCalls } = createRouteApp();
    try {
      const response = await issue(app, {
        target_session_id: TARGET_SESSION,
        label: "  연구 링크  ",
        expires_in_seconds: 3600,
      });

      expect(response.statusCode).toBe(201);
      expect(response.headers["cache-control"]).toBe("no-store");
      const body = response.json();
      expect(body).toMatchObject({
        label: "연구 링크",
        target_session_id: TARGET_SESSION,
        permissions: ["send", "read_own"],
      });
      expect(typeof body.id).toBe("string");
      expect(body.url).toMatch(
        /^https:\/\/soulstream\.example\.test\/x\/ssxl_/,
      );
      expect(typeof body.expires_at).toBe("string");
      expect(Date.parse(body.expires_at)).toBeGreaterThan(Date.now());

      const key = body.url.slice(body.url.indexOf("/x/") + "/x/".length);
      const resolved = await repository.resolveGrant(key, "send");
      expect(resolved.ok && resolved.grant.id).toBe(body.id);
      expect(resolved.ok && resolved.grant.owner_email).toBe(OWNER_EMAIL);

      const listed = await list(app);
      expect(listed.statusCode).toBe(200);
      const items = listed.json() as Array<Record<string, unknown>>;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        id: body.id,
        label: "연구 링크",
        target_session_id: TARGET_SESSION,
        permissions: ["send", "read_own"],
        revoked_at: null,
        last_used_at: null,
      });
      expect(items[0]).not.toHaveProperty("url");
      expect(items[0]).not.toHaveProperty("key_hash");
      expect(JSON.stringify(items)).not.toContain(key);
      expect(JSON.stringify(items)).not.toContain("key_hash");

      expect(accessCalls).toHaveLength(1);
      expect(accessCalls[0]?.request).toBe(SERVICE_CALLER);
      expect(accessCalls[0]).toMatchObject({
        sessionId: TARGET_SESSION,
        accessEmail: OWNER_EMAIL,
      });
    } finally {
      await app.close();
    }
  });

  it("rejects invalid bodies with 422 and stores nothing", async () => {
    const { app } = createRouteApp();
    try {
      const invalid = [
        { target_session_id: TARGET_SESSION, label: "만료 없음" },
        {
          target_session_id: TARGET_SESSION,
          label: "너무 김",
          expires_in_seconds: 2_592_001,
        },
        {
          target_session_id: TARGET_SESSION,
          label: "모르는 권한",
          permissions: ["admin"],
          expires_in_seconds: 3600,
        },
        {
          target_session_id: TARGET_SESSION,
          label: "빈 권한",
          permissions: [],
          expires_in_seconds: 3600,
        },
        {
          target_session_id: TARGET_SESSION,
          label: "   ",
          expires_in_seconds: 3600,
        },
        {
          target_session_id: TARGET_SESSION,
          label: "중복 권한",
          permissions: ["send", "send"],
          expires_in_seconds: 3600,
        },
      ];
      for (const payload of invalid) {
        const response = await issue(app, payload);
        expect(response.statusCode, JSON.stringify(payload)).toBe(422);
        expect(response.json()).toEqual({ detail: "Invalid access link request" });
      }

      const anonymous = await issue(app, {
        target_session_id: TARGET_SESSION,
        label: "로그인 없음",
        expires_in_seconds: 3600,
      }, null);
      expect(anonymous.statusCode).toBe(401);

      expect(await grantRows()).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("answers an unreachable and a missing session with the same 404 and stores nothing", async () => {
    const { app, accessCalls } = createRouteApp();
    try {
      const denied = await issue(app, {
        target_session_id: DENIED_SESSION,
        label: "막힌 세션",
        expires_in_seconds: 3600,
      });
      const missing = await issue(app, {
        target_session_id: MISSING_SESSION,
        label: "없는 세션",
        expires_in_seconds: 3600,
      });

      expect(denied.statusCode).toBe(404);
      expect(missing.statusCode).toBe(404);
      expect(denied.json()).toEqual(missing.json());
      expect(denied.json()).toEqual({ detail: "Session not found" });

      expect(await grantRows()).toHaveLength(0);
      expect(accessCalls).toHaveLength(2);
      for (const call of accessCalls) {
        expect(call.request).toBe(SERVICE_CALLER);
        expect(call.accessEmail).toBe(OWNER_EMAIL);
      }
      expect(accessCalls.map((call) => call.sessionId)).toEqual([
        DENIED_SESSION,
        MISSING_SESSION,
      ]);
    } finally {
      await app.close();
    }
  });

  it("revokes the caller's own link and hides links that are not theirs", async () => {
    const { app, repository } = createRouteApp();
    try {
      const mine = (await issue(app, {
        target_session_id: TARGET_SESSION,
        label: "내 링크",
        expires_in_seconds: 3600,
      })).json();
      const theirs = (await issue(app, {
        target_session_id: TARGET_SESSION,
        label: "남의 링크",
        expires_in_seconds: 3600,
      }, OTHER_EMAIL)).json();
      const myKey = mine.url.slice(mine.url.indexOf("/x/") + "/x/".length);
      const theirKey = theirs.url.slice(theirs.url.indexOf("/x/") + "/x/".length);

      const revoked = await remove(app, mine.id);
      expect(revoked.statusCode).toBe(200);
      expect(revoked.json()).toMatchObject({ id: mine.id, revoked_at: expect.any(String) });
      expect((await repository.resolveGrant(myKey, "send")).ok).toBe(false);

      const foreign = await remove(app, theirs.id);
      expect(foreign.statusCode).toBe(404);
      expect((await repository.resolveGrant(theirKey, "send")).ok).toBe(true);
      const theirRow = (await grantRows()).find((row) => row.id === theirs.id);
      expect(theirRow?.revoked_at).toBeNull();

      const again = await remove(app, mine.id);
      expect(again.statusCode).toBe(404);

      const unknown = await remove(app, "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f");
      expect(unknown.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("lists only the caller's link grants", async () => {
    const { app } = createRouteApp();
    try {
      const mine = (await issue(app, {
        target_session_id: TARGET_SESSION,
        label: "내 링크",
        expires_in_seconds: 3600,
      })).json();
      await issue(app, {
        target_session_id: TARGET_SESSION,
        label: "남의 링크",
        expires_in_seconds: 3600,
      }, OTHER_EMAIL);
      await harness.sql`
        INSERT INTO external_access_grants (
          id, kind, owner_email, label, target_session_id, permissions,
          auth_mode, key_hash, expires_at, created_at
        ) VALUES (
          ${"4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a"}, 'inbound_webhook',
          ${OWNER_EMAIL}, '웹훅', ${TARGET_SESSION}, ARRAY['send']::TEXT[],
          'key', ${hashExternalAccessKey("ssxw_unused_test_key")}, NULL, NOW()
        )
      `;

      const listed = await list(app);
      expect(listed.statusCode).toBe(200);
      const items = listed.json() as Array<{ id: string }>;
      expect(items.map((item) => item.id)).toEqual([mine.id]);

      const anonymous = await list(app, null);
      expect(anonymous.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
