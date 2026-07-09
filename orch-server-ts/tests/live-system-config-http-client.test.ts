import { describe, expect, it, vi } from "vitest";

import {
  createApp,
  createLiveSystemConfigHttpClient,
  parseOrchServerConfig,
  type SystemConfigNodeCandidate,
  type SystemConfigRouteProvider,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

describe("live system config HTTP client adapter", () => {
  it("forwards GET config settings through the live node HTTP boundary with explicit node fields", async () => {
    const provider = createProvider();
    const requestNode = vi.fn(async ({ nodeId }) => {
      if (nodeId === "node-a") {
        return {
          statusCode: 404,
          headers: { "content-type": "application/json" },
          body: { detail: "unsupported" },
        };
      }
      if (nodeId === "node-b") {
        return {
          statusCode: 405,
          headers: { "content-type": "application/json" },
          body: { detail: "unsupported method" },
        };
      }
      if (nodeId === "node-c") throw new Error("connection refused");
      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: { categories: [{ id: "runtime" }] },
      };
    });
    const app = createApp({
      config,
      systemConfigRoutes: {
        provider,
        httpClient: createLiveSystemConfigHttpClient({
          nodeHttpClient: { requestNode },
        }),
      },
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
    expect(response.json()).toEqual({ categories: [{ id: "runtime" }] });
    expect(requestNode).toHaveBeenNthCalledWith(1, {
      nodeId: "node-a",
      method: "GET",
      path: "/api/config/settings",
      headers: {
        authorization: "Bearer user-token",
        cookie: "sid=abc",
      },
    });
    expect(requestNode).toHaveBeenNthCalledWith(2, {
      nodeId: "node-b",
      method: "GET",
      path: "/api/config/settings",
      headers: {
        authorization: "Bearer user-token",
        cookie: "sid=abc",
      },
    });
    expect(requestNode).toHaveBeenNthCalledWith(3, {
      nodeId: "node-c",
      method: "GET",
      path: "/api/config/settings",
      headers: {
        authorization: "Bearer user-token",
        cookie: "sid=abc",
      },
    });
    expect(requestNode).toHaveBeenNthCalledWith(4, {
      nodeId: "node-d",
      method: "GET",
      path: "/api/config/settings",
      headers: {
        authorization: "Bearer user-token",
        cookie: "sid=abc",
      },
    });

    await app.close();
  });

  it("forwards PUT config body and preserves upstream status headers and body", async () => {
    const requestNode = vi.fn(async () => ({
      statusCode: 202,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: { applied: ["KEY"] },
    }));
    const app = createApp({
      config,
      systemConfigRoutes: {
        provider: createProvider(),
        httpClient: createLiveSystemConfigHttpClient({
          nodeHttpClient: { requestNode },
        }),
      },
    });

    const response = await app.inject({
      method: "PUT",
      url: "/api/config/settings",
      headers: {
        authorization: "Bearer user-token",
        "x-extra": "not-forwarded",
      },
      payload: { changes: { KEY: "value" } },
    });

    expect(response.statusCode).toBe(202);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual({ applied: ["KEY"] });
    expect(requestNode).toHaveBeenCalledWith({
      nodeId: "node-a",
      method: "PUT",
      path: "/api/config/settings",
      headers: { authorization: "Bearer user-token" },
      body: { changes: { KEY: "value" } },
    });

    await app.close();
  });

  it("forwards dashboard config and lets the route add the node-scoped portrait URL", async () => {
    const requestNode = vi.fn(async () => ({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: {
        user: { name: "Ada", id: "u1", hasPortrait: true },
        agents: [],
      },
    }));
    const app = createApp({
      config,
      systemConfigRoutes: {
        provider: createProvider(),
        httpClient: createLiveSystemConfigHttpClient({
          nodeHttpClient: { requestNode },
        }),
      },
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
      agents: [],
    });
    expect(requestNode).toHaveBeenCalledWith({
      nodeId: "node-a",
      method: "GET",
      path: "/api/dashboard/config",
      headers: {},
    });

    await app.close();
  });
});

function createProvider(): SystemConfigRouteProvider {
  const nodes: SystemConfigNodeCandidate[] = [
    { nodeId: "node-a", host: "localhost", port: 4105 },
    { nodeId: "node-b", host: "localhost", port: 4106 },
    { nodeId: "node-c", host: "localhost", port: 4107 },
    { nodeId: "node-d", host: "localhost", port: 4108 },
  ];
  return {
    async getSystemPortrait() {
      throw new Error("portrait route is not used by these tests");
    },
    listConnectedNodes() {
      return nodes;
    },
  };
}
