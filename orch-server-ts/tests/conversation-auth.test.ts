import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerConversationRoutes, conversationRouteAuthRequirements } from "../src/conversation/conversation_routes.js";
import { oauthScopeForRoute, type OAuthResourceAccess } from "../src/oauth/oauth_access.js";
import { createLiveAuthenticatedUserResolvers } from "../src/runtime/live_authenticated_user_resolver.js";
import { registerProductionAuthGuard } from "../src/runtime/production_auth_guard.js";

const oauth: OAuthResourceAccess = {
  email: "person@example.test", displayName: "Person", clientId: "client", clientName: "Example",
  scopes: ["conversations"],
};

describe("conversation route authentication", () => {
  it("assigns the conversations scope to every registered conversation route and method", () => {
    for (const key of Object.keys(conversationRouteAuthRequirements)) {
      const [method, path] = key.split(" ");
      expect(oauthScopeForRoute(method!, `${path}?example=1`), key).toBe("conversations");
    }
    expect(oauthScopeForRoute("GET", "/api/conversations/v10/models")).toBeNull();
  });

  it("applies OAuth scope and conversation errors to real routes while preserving other API errors", async () => {
    const resolveOAuthToken = vi.fn(async (token: string) => token === "conversation-token" ? oauth
      : token === "wrong-scope-token" ? { ...oauth, scopes: ["cards:read"] as const } : null);
    const isServiceBearer = async (request: import("fastify").FastifyRequest) => request.headers.authorization === "Bearer service-token";
    const jwt = { issueToken: async () => "dashboard-token", verifyToken: async (token: string) =>
      token === "dashboard-token" ? { email: "person@example.test" } : null };
    const users = createLiveAuthenticatedUserResolvers({ jwt, resolveOAuthToken, isServiceBearer });
    const app = Fastify();
    registerProductionAuthGuard(app, {
      resolveTokenAccess: async request => await isServiceBearer(request) || await users.resolveUser(request) !== null
        ? { ok: true } : { ok: false, statusCode: 401, detail: "Authentication required" },
      resolveOAuthAccess: users.resolveOAuthAccess,
    });
    const models = vi.fn(() => ({ models: [{ id: "model", label: "Model", available: true }] }));
    registerConversationRoutes(app, { service: { models } as never, resolveAccount: async request =>
      await users.resolveEmail(request) ?? (await isServiceBearer(request) ? "service-token" : null) });
    app.get("/api/cards", async () => ({ ok: true }));
    const get = (token?: string) => app.inject({ method: "GET", url: "/api/conversations/v1/models",
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) });
    for (const token of ["service-token", "dashboard-token"]) {
      const response = await get(token); expect(response.statusCode).toBe(200);
      expect(resolveOAuthToken).not.toHaveBeenCalled();
    }
    const allowed = await get("conversation-token");
    expect(allowed.statusCode).toBe(200); expect(allowed.json().models).toHaveLength(1);
    const denied = await get("wrong-scope-token");
    expect(denied.statusCode).toBe(403); expect(denied.json()).toEqual({ error: { code: "forbidden", message: "Insufficient OAuth scope" } });
    for (const token of [undefined, "invalid-token", "expired-token"]) {
      const denied = await get(token); expect(denied.statusCode).toBe(401);
      expect(denied.json()).toEqual({ error: { code: "login_required", message: "Authentication required" } });
    }
    const other = await app.inject({ method: "GET", url: "/api/cards" });
    expect(other.statusCode).toBe(401); expect(other.json()).toEqual({ detail: "Authentication required" });
    expect(models).toHaveBeenCalledTimes(3);
    await app.close();
  });
});
