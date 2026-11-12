import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { SqlClient } from "../../src/control_plane/control_plane_types.js";
import { createLiveAuthenticatedUserResolvers } from "../../src/runtime/live_authenticated_user_resolver.js";
import { createLiveDashboardAccessProvider } from "../../src/runtime/live_dashboard_access_provider.js";
import { registerProductionAuthGuard } from "../../src/runtime/production_auth_guard.js";
import { registerUsageSummaryRoutes } from "../../src/usage/usage_summary_routes.js";
import { registerSessionStatisticsRoutes } from "../../src/usage/session_statistics_routes.js";
import {
  createOAuthAccessTokenResolver,
  oauthScopeForRoute,
  persistOAuthProfile,
  requireOAuthScope,
  type OAuthResourceAccess,
} from "../../src/oauth/oauth_access.js";
import { repositoryModelCatalog } from "../helpers/model_catalog.js";

const catalog = repositoryModelCatalog();

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
      nodeCredentials: null,
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

  it("maps only the usage summary and session statistics GETs to the usage read scope", () => {
    expect(oauthScopeForRoute("GET", "/api/usage/summary")).toBe("usage:read");
    expect(oauthScopeForRoute("GET", "/api/usage/summary?window=1")).toBe("usage:read");
    expect(oauthScopeForRoute("GET", "/api/session-statistics?period=week&timezone=Asia/Seoul")).toBe("usage:read");
    expect(oauthScopeForRoute("GET", "/api/session-statistics/days/2026-11-10?period=week")).toBe("usage:read");
    for (const [method, path] of [
      ["POST", "/api/usage/refresh"],
      ["GET", "/api/usage/stream"],
      ["GET", "/api/usage/summary/x"],
      ["POST", "/api/usage/summary"],
      ["POST", "/api/session-statistics"],
      ["GET", "/api/session-statistics/days"],
      ["GET", "/api/session-statistics/days/2026-11-10/x"],
      ["GET", "/api/session-statistics/other"],
    ]) expect(oauthScopeForRoute(method!, path!)).toBeNull();
  });

  it("admits a usage read token only to the usage summary route", async () => {
    const usage: OAuthResourceAccess = { ...access, scopes: ["usage:read"] };
    const cards: OAuthResourceAccess = { ...access, scopes: ["cards:read"] };
    const app = Fastify();
    registerProductionAuthGuard(app, {
      resolveTokenAccess: async () => ({ ok: false, statusCode: 401, detail: "Authentication required" }),
      resolveOAuthAccess: async request => request.headers.authorization === "Bearer usage-token"
        ? usage
        : request.headers.authorization === "Bearer cards-token" ? cards : null,
    });
    registerUsageSummaryRoutes(app, {
      service: {
        getSummary: () => ({ generatedAt: "2026-11-09T00:00:00.000Z", collectedAt: null, nodes: [] }),
        collectOnce: async () => {},
      },
    });
    const headers = { authorization: "Bearer usage-token" };
    expect((await app.inject({ method: "GET", url: "/api/usage/summary", headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/usage/summary", headers: { authorization: "Bearer cards-token" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/usage/refresh", headers })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/usage/stream", headers })).statusCode).toBe(403);
    await app.close();
  });

  it("admits a usage read token to the session statistics overview and day routes", async () => {
    const usage: OAuthResourceAccess = { ...access, scopes: ["usage:read"] };
    const cards: OAuthResourceAccess = { ...access, scopes: ["cards:read"] };
    const app = Fastify();
    registerProductionAuthGuard(app, {
      resolveTokenAccess: async () => ({ ok: false, statusCode: 401, detail: "Authentication required" }),
      resolveOAuthAccess: async request => request.headers.authorization === "Bearer usage-token"
        ? usage
        : request.headers.authorization === "Bearer cards-token" ? cards : null,
    });
    registerSessionStatisticsRoutes(app, {
      modelCatalog: catalog,
      service: {
        getOverview: async () => ({
          kind: "overview",
          by_model: [],
          options: { models: [] },
          series: [],
        }) as never,
        getDay: async () => ({ kind: "day", by_model: [] }) as never,
      },
      accessProvider: { resolveAccess: async () => ({ restricted: false, allowedFolderIds: [] }) },
      folderProvider: { listFolders: async () => [] },
      now: () => new Date("2026-11-11T00:00:00.000Z"),
    });
    const headers = { authorization: "Bearer usage-token" };
    const overview = await app.inject({ method: "GET", url: "/api/session-statistics?period=week&timezone=Asia/Seoul", headers });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toEqual({ kind: "overview", by_model: [], options: { models: [] }, series: [] });
    const day = await app.inject({ method: "GET", url: "/api/session-statistics/days/2026-11-10?period=week&anchor=2026-11-10", headers });
    expect(day.statusCode).toBe(200);
    expect(day.json()).toEqual({ kind: "day", by_model: [] });
    expect((await app.inject({ method: "GET", url: "/api/session-statistics", headers: { authorization: "Bearer cards-token" } })).statusCode).toBe(403);
    await app.close();
  });

  it("lets the card read scope write card status, comments and messages", () => {
    for (const method of ["POST", "PATCH"]) {
      expect(oauthScopeForRoute(method, "/api/cards")).toBe("cards:read");
      expect(oauthScopeForRoute(method, "/api/cards/card-1/status")).toBe("cards:read");
      expect(oauthScopeForRoute(method, "/api/cards/card-1/comments")).toBe("cards:read");
      expect(oauthScopeForRoute(method, "/api/cards/card-1/messages")).toBe("cards:read");
    }
  });

  it("keeps every other method and resource outside the OAuth allowlist", () => {
    expect(oauthScopeForRoute("POST", "/api/folders")).toBeNull();
    expect(oauthScopeForRoute("PATCH", "/api/folders/folder-1")).toBeNull();
    expect(oauthScopeForRoute("DELETE", "/api/cards/card-1")).toBeNull();
    expect(oauthScopeForRoute("POST", "/api/sessions")).toBeNull();
  });

  it("allows only the specified folder content and session routes for cards tokens", () => {
    for (const [method, path] of [
      ["GET", "/api/board-items"],
      ["GET", "/api/markdown-documents"],
      ["POST", "/api/markdown-documents"],
      ["GET", "/api/markdown-documents/doc-1"],
      ["PUT", "/api/markdown-documents/doc-1"],
      ["PATCH", "/api/markdown-documents/doc-1"],
      ["GET", "/api/sessions"],
      ["GET", "/api/sessions/session-1/conversation"],
      ["POST", "/api/sessions/session-1/intervene"],
      ["POST", "/api/sessions/session-1/interrupt"],
      ["GET", "/api/attachments/files"],
      ["GET", "/api/attachments/files?nodeId=eiaserinnys&path=%2Ftmp%2Fa.png"],
      ["GET", "/api/attachments/asset-1"],
      ["GET", "/api/attachments/asset-1/content"],
      ["HEAD", "/api/attachments/asset-1/content"],
    ]) expect(oauthScopeForRoute(method!, path!)).toBe("cards:read");
    for (const [method, path] of [
      ["DELETE", "/api/markdown-documents/doc-1"],
      ["GET", "/api/sessions/session-1"],
      ["POST", "/api/sessions/session-1/approve"],
      ["GET", "/api/sessions/session-1/conversation/extra"],
      ["POST", "/api/attachments/sessions"],
      ["DELETE", "/api/attachments/sessions/session-1"],
      ["GET", "/api/attachments/worker/asset-1/content"],
      ["POST", "/api/attachments/agent-register"],
      ["POST", "/api/attachments/agent-output/validate"],
    ]) expect(oauthScopeForRoute(method!, path!)).toBeNull();
    expect(requireOAuthScope({ ...access, scopes: ["cards:read"] }, "folders:read")).toEqual({ ok: true });
    expect(requireOAuthScope({ ...access, scopes: ["folders:read"] }, "cards:read")).toMatchObject({ ok: false });
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

  it("does not derive the usage read scope from another scope", () => {
    expect(requireOAuthScope({ ...access, scopes: ["cards:read", "folders:read", "conversations"] }, "usage:read"))
      .toEqual({ ok: false, statusCode: 403, detail: "Insufficient OAuth scope" });
    expect(requireOAuthScope({ ...access, scopes: ["usage:read"] }, "cards:read")).toMatchObject({ ok: false });
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
