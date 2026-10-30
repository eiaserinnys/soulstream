import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { SqlClient } from "../../src/control_plane/control_plane_types.js";
import { createLiveAuthenticatedUserResolvers } from "../../src/runtime/live_authenticated_user_resolver.js";
import { createLiveDashboardAccessProvider } from "../../src/runtime/live_dashboard_access_provider.js";
import { registerProductionAuthGuard } from "../../src/runtime/production_auth_guard.js";
import {
  createOAuthAccessTokenResolver,
  oauthScopeForRoute,
  persistOAuthProfile,
  requireOAuthScope,
  type OAuthResourceAccess,
} from "../../src/oauth/oauth_access.js";

const access: OAuthResourceAccess = {
  email: "director@example.test",
  displayName: "Director",
  avatarUrl: "https://example.test/director.png",
  clientId: "client-1",
  clientName: "Native Client",
  scopes: ["cards:read", "folders:read"],
};

describe("OAuth resource scopes", () => {
  it("resolves service and dashboard credentials before querying OAuth across guard, caller and folder access", async () => {
    const resolveOAuthToken = vi.fn(async (token: string) => token === "oauth-token" ? access : null);
    const jwt = {
      issueToken: async () => "dashboard-token",
      verifyToken: async (token: string) => token === "dashboard-token" ? { email: "director@example.test" } : null,
    };
    const isServiceBearer = async (request: import("fastify").FastifyRequest) => request.headers.authorization === "Bearer service-token";
    const users = createLiveAuthenticatedUserResolvers({ jwt, resolveOAuthToken, isServiceBearer });
    const accessProvider = createLiveDashboardAccessProvider({
      configProvider: { getConfig: async () => ({ auth_bearer_token: "service-token", environment: "production", google_client_id: "client" }), requireConfig: async (key: string) => key },
      jwt, verifyDashboardToken: users.verifyToken, resolveOAuthAccess: users.resolveOAuthAccess,
      repository: { findUserByEmail: async () => ({ email: access.email, isAdmin: false, allowedFolderIds: ["allowed"] }) },
    });
    const app = Fastify();
    registerProductionAuthGuard(app, {
      resolveTokenAccess: async request => await isServiceBearer(request) || await users.resolveUser(request) !== null
        ? { ok: true }
        : { ok: false, statusCode: 401, detail: "Authentication required" },
      resolveOAuthAccess: users.resolveOAuthAccess,
    });
    app.get("/api/cards", async request => ({
      email: await users.resolveEmail(request),
      caller: await users.resolveCallerInfo(request, null, "node"),
      access: await accessProvider.resolveAccess(request),
    }));
    for (const token of ["service-token", "dashboard-token"]) {
      const response = await app.inject({ method: "GET", url: "/api/cards", headers: { authorization: `Bearer ${token}` } });
      expect(response.statusCode).toBe(200);
      expect(resolveOAuthToken).not.toHaveBeenCalled();
      expect(response.json().access).toEqual(token === "service-token"
        ? { restricted: false, allowedFolderIds: [] }
        : { restricted: true, allowedFolderIds: ["allowed"] });
    }
    const oauth = await app.inject({ method: "GET", url: "/api/cards", headers: { authorization: "Bearer oauth-token" } });
    expect(oauth.statusCode).toBe(200);
    expect(oauth.json()).toMatchObject({ email: access.email, caller: { transport: "oauth" }, access: { restricted: true, allowedFolderIds: ["allowed"] } });
    expect(resolveOAuthToken).toHaveBeenCalledTimes(1);
    const unknown = await app.inject({ method: "GET", url: "/api/cards", headers: { authorization: "Bearer unknown" } });
    expect(unknown.statusCode).toBe(401);
    expect(resolveOAuthToken).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("requires the matching read scope for card and folder GET routes", () => {
    expect(oauthScopeForRoute("GET", "/api/cards")).toBe("cards:read");
    expect(oauthScopeForRoute("GET", "/api/cards/card-1")).toBe("cards:read");
    expect(oauthScopeForRoute("GET", "/api/folders")).toBe("folders:read");
    expect(oauthScopeForRoute("GET", "/api/folders/folder-1")).toBe("folders:read");
  });

  it("keeps every other method and resource outside the OAuth allowlist", () => {
    expect(oauthScopeForRoute("POST", "/api/cards")).toBeNull();
    expect(oauthScopeForRoute("GET", "/api/sessions")).toBeNull();
    expect(oauthScopeForRoute("POST", "/api/sessions")).toBeNull();
  });

  it("checks a resolved token for the requested scope", () => {
    expect(requireOAuthScope(access, "cards:read")).toEqual({ ok: true });
    expect(requireOAuthScope(access, "folders:read")).toEqual({ ok: true });
    expect(requireOAuthScope(access, "conversations")).toEqual({
      ok: false,
      statusCode: 403,
      detail: "Insufficient OAuth scope",
    });
    expect(requireOAuthScope(null, "conversations")).toMatchObject({ ok: false });
  });

  it("uses the verified Google profile for OAuth caller identity", async () => {
    const entities = new Map<string, Record<string, unknown>>();
    const sql = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const statement = strings.join("?");
      if (statement.includes("INSERT INTO oauth_entities")) {
        entities.set(`${String(values[0])}:${String(values[1])}`, values[2] as Record<string, unknown>);
        return [];
      }
      if (statement.includes("SELECT payload, consumed_at FROM oauth_entities")) {
        const payload = entities.get(`${String(values[0])}:${String(values[1])}`);
        return payload === undefined ? [] : [{ payload, consumed_at: null }];
      }
      return [];
    }, { json: (value: unknown) => value }) as unknown as SqlClient;
    entities.set("AccessToken:opaque-token", {
      accountId: "director@example.test",
      clientId: "client-1",
      scope: "cards:read folders:read",
    });
    entities.set("Client:client-1", { client_name: "Native Client" });

    await persistOAuthProfile(sql, {
      email: "Director@Example.Test",
      name: "Director",
      picture: "https://example.test/director.png",
    });
    const resolve = createOAuthAccessTokenResolver(sql, async () => null);

    await expect(resolve("opaque-token")).resolves.toMatchObject({
      email: "director@example.test",
      displayName: "Director",
      avatarUrl: "https://example.test/director.png",
    });
  });
});
