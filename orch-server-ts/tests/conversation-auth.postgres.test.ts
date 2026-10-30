import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createFullSchemaPostgresHarness, type FullSchemaPostgresHarness } from "./board_yjs_postgres_harness.js";
import { createOAuthAccessTokenResolver } from "../src/oauth/oauth_access.js";
import { createLiveAuthenticatedUserResolvers } from "../src/runtime/live_authenticated_user_resolver.js";
import { registerProductionAuthGuard } from "../src/runtime/production_auth_guard.js";
import { registerConversationRoutes } from "../src/conversation/conversation_routes.js";

let db: FullSchemaPostgresHarness;
describe("conversation OAuth tokens against stored grants", () => {
  beforeAll(async () => { db = await createFullSchemaPostgresHarness(); }, 60_000);
  afterAll(async () => { await db?.cleanup(); });
  it("authenticates real stored tokens, checks scope and rejects expiration on the actual route", async () => {
    const token = (scope: string) => ({ accountId: "person@example.test", clientId: "client-1", scope });
    await db.sql`INSERT INTO oauth_entities (kind,id,payload,expires_at) VALUES
      ('Client','client-1',${db.sql.json({ client_name: "Client" })},NULL),
      ('AccessToken','valid',${db.sql.json(token("conversations"))},now()+interval '1 hour'),
      ('AccessToken','wrong-scope',${db.sql.json(token("cards:read"))},now()+interval '1 hour'),
      ('AccessToken','expired',${db.sql.json(token("conversations"))},now()-interval '1 second')`;
    const resolveOAuthToken = vi.fn(createOAuthAccessTokenResolver(db.sql as never));
    const isServiceBearer = async (request: import("fastify").FastifyRequest) => request.headers.authorization === "Bearer service-token";
    const jwt = { issueToken: async () => "jwt", verifyToken: async () => null };
    const users = createLiveAuthenticatedUserResolvers({ jwt, resolveOAuthToken, isServiceBearer });
    const app = Fastify();
    registerProductionAuthGuard(app, {
      resolveTokenAccess: async request => await isServiceBearer(request) ? { ok: true } : { ok: false, statusCode: 401, detail: "Authentication required" },
      resolveOAuthAccess: users.resolveOAuthAccess,
    });
    registerConversationRoutes(app, { service: { models: () => ({ models: [] }) } as never,
      resolveAccount: async request => await users.resolveEmail(request) ?? (await isServiceBearer(request) ? "service-token" : null) });
    const get = (value?: string) => app.inject({ method: "GET", url: "/api/conversations/v1/models",
      ...(value ? { headers: { authorization: `Bearer ${value}` } } : {}) });
    expect((await get("valid")).statusCode).toBe(200);
    const denied = await get("wrong-scope");
    expect(denied.statusCode).toBe(403); expect(denied.json().error.code).toBe("forbidden");
    for (const value of [undefined, "expired", "unknown"]) {
      const result = await get(value); expect(result.statusCode).toBe(401); expect(result.json().error.code).toBe("login_required");
    }
    resolveOAuthToken.mockClear();
    expect((await get("service-token")).statusCode).toBe(200);
    expect(resolveOAuthToken).not.toHaveBeenCalled();
    await app.close();
  });
});
