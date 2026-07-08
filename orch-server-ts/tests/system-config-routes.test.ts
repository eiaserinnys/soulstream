import { describe, expect, it, vi } from "vitest";

import {
  createApp,
  loadContractFixtures,
  parseOrchServerConfig,
  systemConfigRouteAuthRequirements,
  type SystemConfigHttpClient,
  type SystemConfigNodeCandidate,
  type SystemConfigRouteProvider,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

type ProviderCall =
  | ["portrait", string]
  | ["nodes"];

function createProvider(
  overrides: Partial<SystemConfigRouteProvider> = {},
): { provider: SystemConfigRouteProvider; calls: ProviderCall[] } {
  const calls: ProviderCall[] = [];
  const nodes: SystemConfigNodeCandidate[] = [
    { nodeId: "node-a", host: "localhost", port: 4105 },
    { nodeId: "node-b", host: "localhost", port: 4106 },
    { nodeId: "node-c", host: "localhost", port: 4107 },
  ];
  const provider: SystemConfigRouteProvider = {
    async getSystemPortrait(source) {
      calls.push(["portrait", source]);
      if (source === "system") return { body: "png-system" };
      if (source === "channel_observer") {
        return { body: Buffer.from("png-channel").toString("base64"), encoding: "base64" };
      }
      return undefined;
    },
    async listConnectedNodes() {
      calls.push(["nodes"]);
      return nodes;
    },
    ...overrides,
  };
  return { provider, calls };
}

function createHttpClient(
  handler: SystemConfigHttpClient,
): SystemConfigHttpClient {
  return vi.fn(handler);
}

describe("system portrait/config route harness", () => {
  const fixtures = loadContractFixtures();

  it("keeps system/config routes disabled on the default app", async () => {
    const app = createApp({ config });

    for (const [method, url, payload] of [
      ["GET", "/api/system/portraits/system", undefined],
      ["GET", "/api/config/settings", undefined],
      ["PUT", "/api/config/settings", { categories: [] }],
      ["GET", "/api/dashboard/config", undefined],
    ] as const) {
      expect(await app.inject({ method, url, payload })).toMatchObject({
        statusCode: 404,
      });
    }

    await app.close();
  });

  it("registers Python auth contract rows for route inventory order 45-48", () => {
    expect(systemConfigRouteAuthRequirements).toEqual({
      "GET /api/system/portraits/:source": true,
      "GET /api/config/settings": true,
      "PUT /api/config/settings": true,
      "GET /api/dashboard/config": true,
    });

    const routeRows = fixtures.routeInventory.routes
      .filter((route) =>
        [
          "get_system_portrait",
          "proxy_config_settings_get",
          "proxy_config_settings_put",
          "proxy_dashboard_config",
        ].includes(route.name),
      )
      .map((route) => [route.order, route.methods[0], route.path, route.authRequired]);

    expect(routeRows).toEqual([
      [45, "GET", "/api/system/portraits/{source}", true],
      [46, "GET", "/api/config/settings", true],
      [47, "PUT", "/api/config/settings", true],
      [48, "GET", "/api/dashboard/config", true],
    ]);
  });

  it("serves only whitelisted system portraits as PNG with cache header", async () => {
    const { provider, calls } = createProvider();
    const httpClient = createHttpClient(async () => {
      throw new Error("portrait route must not use node HTTP");
    });
    const app = createApp({
      config,
      systemConfigRoutes: { provider, httpClient },
    });

    const system = await app.inject({
      method: "GET",
      url: "/api/system/portraits/system",
    });
    expect(system.statusCode).toBe(200);
    expect(system.headers["content-type"]).toContain("image/png");
    expect(system.headers["cache-control"]).toBe("public, max-age=3600");
    expect(system.body).toBe("png-system");

    const base64 = await app.inject({
      method: "GET",
      url: "/api/system/portraits/channel_observer",
    });
    expect(base64.statusCode).toBe(200);
    expect(base64.body).toBe("png-channel");

    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/system/portraits/unknown",
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/system/portraits/trello_watcher",
        })
      ).statusCode,
    ).toBe(404);
    expect(calls).toEqual([
      ["portrait", "system"],
      ["portrait", "channel_observer"],
      ["portrait", "trello_watcher"],
    ]);
    expect(httpClient).not.toHaveBeenCalled();

    await app.close();
  });

  it("proxies GET config settings to the first supported node with auth headers only", async () => {
    const { provider } = createProvider();
    const httpClient = createHttpClient(async (request) => {
      if (request.node.nodeId === "node-a") {
        return {
          statusCode: 404,
          headers: { "content-type": "application/json" },
          body: { detail: "unsupported" },
        };
      }
      if (request.node.nodeId === "node-b") {
        throw new Error("connection refused");
      }
      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: { categories: [{ id: "general" }] },
      };
    });
    const app = createApp({
      config,
      systemConfigRoutes: { provider, httpClient },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/config/settings",
      headers: {
        authorization: "Bearer user-token",
        cookie: "sid=abc",
        "x-forwarded-for": "203.0.113.10",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ categories: [{ id: "general" }] });
    expect(httpClient).toHaveBeenCalledTimes(3);
    expect(httpClient).toHaveBeenNthCalledWith(1, {
      method: "GET",
      url: "http://localhost:4105/api/config/settings",
      path: "/api/config/settings",
      headers: {
        authorization: "Bearer user-token",
        cookie: "sid=abc",
      },
      node: { nodeId: "node-a", host: "localhost", port: 4105 },
    });
    expect(httpClient).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        url: "http://localhost:4107/api/config/settings",
        node: { nodeId: "node-c", host: "localhost", port: 4107 },
      }),
    );

    await app.close();
  });

  it("returns config settings fallback when no connected node supports the route", async () => {
    const { provider } = createProvider({
      async listConnectedNodes() {
        return [{ nodeId: "node-a", host: "localhost", port: 4105 }];
      },
    });
    const httpClient = createHttpClient(async () => ({
      statusCode: 405,
      headers: { "content-type": "application/json" },
      body: { detail: "unsupported" },
    }));
    const app = createApp({
      config,
      systemConfigRoutes: { provider, httpClient },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/config/settings",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ categories: [] });

    await app.close();
  });

  it("preserves upstream non-unsupported GET config status and JSON body", async () => {
    const { provider } = createProvider();
    const httpClient = createHttpClient(async () => ({
      statusCode: 401,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: { detail: "unauthorized" },
    }));
    const app = createApp({
      config,
      systemConfigRoutes: { provider, httpClient },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/config/settings",
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual({ detail: "unauthorized" });
    expect(httpClient).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("proxies PUT config settings body and preserves upstream response", async () => {
    const { provider } = createProvider();
    const httpClient = createHttpClient(async (request) => ({
      statusCode: 202,
      headers: { "content-type": "application/json" },
      body: { saved: true, received: request.body },
    }));
    const app = createApp({
      config,
      systemConfigRoutes: { provider, httpClient },
    });

    const response = await app.inject({
      method: "PUT",
      url: "/api/config/settings",
      headers: {
        authorization: "Bearer user-token",
        "x-extra": "not-forwarded",
      },
      payload: { categories: [{ id: "general", value: true }] },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      saved: true,
      received: { categories: [{ id: "general", value: true }] },
    });
    expect(httpClient).toHaveBeenCalledWith({
      method: "PUT",
      url: "http://localhost:4105/api/config/settings",
      path: "/api/config/settings",
      headers: { authorization: "Bearer user-token" },
      body: { categories: [{ id: "general", value: true }] },
      node: { nodeId: "node-a", host: "localhost", port: 4105 },
    });

    await app.close();
  });

  it("returns Python PUT fallback detail when every node is unsupported", async () => {
    const { provider } = createProvider({
      async listConnectedNodes() {
        return [];
      },
    });
    const httpClient = createHttpClient(async () => {
      throw new Error("no request expected");
    });
    const app = createApp({
      config,
      systemConfigRoutes: { provider, httpClient },
    });

    const response = await app.inject({
      method: "PUT",
      url: "/api/config/settings",
      payload: { categories: [] },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      detail: "설정을 저장할 수 있는 노드가 없습니다",
    });
    expect(httpClient).not.toHaveBeenCalled();

    await app.close();
  });

  it("adds node-scoped portraitUrl to dashboard config user when upstream has portrait", async () => {
    const { provider } = createProvider();
    const httpClient = createHttpClient(async () => ({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: {
        user: { name: "Ada", id: "u1", hasPortrait: true },
        agents: [{ id: "agent-a" }],
      },
    }));
    const app = createApp({
      config,
      systemConfigRoutes: { provider, httpClient },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/dashboard/config",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      user: {
        name: "Ada",
        id: "u1",
        hasPortrait: true,
        portraitUrl: "/api/nodes/node-a/user/portrait",
      },
      agents: [{ id: "agent-a" }],
    });

    await app.close();
  });

  it("returns dashboard config fallback and preserves non-200 JSON upstream responses", async () => {
    const fallbackProvider = createProvider({
      async listConnectedNodes() {
        return [];
      },
    });
    const fallbackApp = createApp({
      config,
      systemConfigRoutes: {
        provider: fallbackProvider.provider,
        httpClient: createHttpClient(async () => {
          throw new Error("no request expected");
        }),
      },
    });
    expect(
      (
        await fallbackApp.inject({
          method: "GET",
          url: "/api/dashboard/config",
        })
      ).json(),
    ).toEqual({
      user: { name: "User", id: "", hasPortrait: false },
      agents: [],
    });
    await fallbackApp.close();

    const upstreamProvider = createProvider();
    const upstreamApp = createApp({
      config,
      systemConfigRoutes: {
        provider: upstreamProvider.provider,
        httpClient: createHttpClient(async () => ({
          statusCode: 403,
          headers: { "content-type": "application/json" },
          body: { detail: "forbidden" },
        })),
      },
    });
    const response = await upstreamApp.inject({
      method: "GET",
      url: "/api/dashboard/config",
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ detail: "forbidden" });
    await upstreamApp.close();
  });
});
