import { describe, expect, it, vi } from "vitest";

import {
  createApp,
  parseOrchServerConfig,
  resolveProductionRouteAuthRequirement,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

describe("production auth guard", () => {
  it("enforces protected routes and exempts public routes from the auth matrix", async () => {
    const resolveTokenAccess = vi.fn(async () => ({
      ok: false as const,
      statusCode: 401,
      detail: "Authorization header required",
    }));
    const app = createApp({
      config,
      productionAuth: { resolveTokenAccess },
      publicStatusRoutes: createPublicStatusRouteOptions(),
    });

    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(resolveTokenAccess).not.toHaveBeenCalled();

    const healthHead = await app.inject({ method: "HEAD", url: "/api/health" });
    expect(healthHead.statusCode).toBe(200);
    expect(resolveTokenAccess).not.toHaveBeenCalled();

    const status = await app.inject({ method: "GET", url: "/api/status" });
    expect(status.statusCode).toBe(401);
    expect(status.json()).toEqual({ detail: "Authorization header required" });
    expect(resolveTokenAccess).toHaveBeenCalledTimes(1);

    const statusHead = await app.inject({ method: "HEAD", url: "/api/status" });
    expect(statusHead.statusCode).toBe(401);
    expect(resolveTokenAccess).toHaveBeenCalledTimes(2);

    await app.close();
  });

  it("leaves individual opt-in test harnesses unchanged when the guard is omitted", async () => {
    const app = createApp({
      config,
      publicStatusRoutes: createPublicStatusRouteOptions(),
    });

    const status = await app.inject({ method: "GET", url: "/api/status" });
    expect(status.statusCode).toBe(200);

    await app.close();
  });

  it("uses protocol-aware matrix keys for SSE, public HTTP, and WebSocket routes", () => {
    expect(resolveProductionRouteAuthRequirement({
      method: "GET",
      routeUrl: "/api/sessions/stream",
    })).toBe(true);
    expect(resolveProductionRouteAuthRequirement({
      method: "GET",
      routeUrl: "/api/sessions/:session_id/background-tasks",
    })).toBe(true);
    expect(resolveProductionRouteAuthRequirement({
      method: "GET",
      routeUrl: "/api/health",
    })).toBe(false);
    expect(resolveProductionRouteAuthRequirement({
      method: "GET",
      routeUrl: "/ws/node",
      websocket: true,
    })).toBe(false);
    for (const [method, routeUrl] of [
      ["GET", "/api/pages"],
      ["POST", "/api/pages/daily"],
      ["GET", "/api/pages/:pageId"],
      ["GET", "/api/pages/search"],
      ["GET", "/api/pages/:pageId/backlinks"],
      ["GET", "/api/blocks/search"],
      ["GET", "/api/blocks/:blockId"],
      ["POST", "/api/pages/:pageId/operations"],
      ["PATCH", "/api/pages/:pageId/starred"],
    ] as const) {
      expect(resolveProductionRouteAuthRequirement({ method, routeUrl })).toBe(true);
    }
  });
});

function createPublicStatusRouteOptions() {
  return {
    configProvider: {
      getConfig: () => ({
        authEnabled: true,
        atomEnabled: false,
      }),
    },
    folderCountsProvider: {
      getFolderCounts: () => new Map<string | null, number>(),
      listFolders: () => [],
      resolveAccess: () => ({ restricted: false }),
    },
  };
}
