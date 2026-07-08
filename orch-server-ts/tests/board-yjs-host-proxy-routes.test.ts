import { describe, expect, it, vi } from "vitest";

import {
  InMemoryNodeRegistry,
  createApp,
  loadContractFixtures,
  registerBoardYjsHostProxyRoutes,
  boardYjsHostProxyRouteAuthRequirements,
  type BoardYjsHostHttpClient,
  type NodeRegistrationPayload,
} from "../src/index.js";

describe("Board Y.Doc host proxy route harness", () => {
  const fixtures = loadContractFixtures();
  const fixture = fixtures.boardYjsHostProxy;
  const config = {
    environment: "test" as const,
    databaseUrl: "postgresql://test/test",
    authBearerToken: "test-token",
  };

  function createRegistry(): InMemoryNodeRegistry {
    return new InMemoryNodeRegistry({
      nowMs: () => 1_700_000_000_000,
    });
  }

  function registerNode(
    registry: InMemoryNodeRegistry,
    nodeId: string,
    port: number,
    isHost: boolean,
  ): string {
    return registry.registerNode({
      type: "node_register",
      node_id: nodeId,
      host: "localhost",
      port,
      agents: [],
      capabilities: {
        board_yjs_host: isHost,
      },
    } satisfies NodeRegistrationPayload).node.connectionId;
  }

  it("keeps Board Y.Doc host proxy routes disabled on the default app", async () => {
    const app = createApp({ config });

    expect(
      await app.inject({
        method: "POST",
        url: fixture.proxy.route,
        payload: { folderId: "f1", title: "Note", body: "Body" },
      }),
    ).toMatchObject({ statusCode: 404 });
    expect(
      await app.inject({
        method: "POST",
        url: "/api/board-yjs/host/update",
        payload: { update: "payload" },
      }),
    ).toMatchObject({ statusCode: 404 });
  });

  it("registers only the auth-required board-yjs proxy route when explicitly enabled", async () => {
    const registry = createRegistry();
    const httpClient: BoardYjsHostHttpClient = vi.fn();
    const app = createApp({
      config,
      boardYjsHostProxyRoutes: { registry, httpClient },
    });

    expect(boardYjsHostProxyRouteAuthRequirements).toEqual({
      "POST /api/board-yjs/host/{operation}": true,
    });
    expect(
      fixtures.routeInventory.routes
        .filter(
          (route) =>
            route.name === "proxy_board_yjs_host_operation",
        )
        .map((route) => [route.methods[0], route.path, route.authRequired]),
    ).toEqual([
      ["POST", "/api/board-yjs/host/{operation}", true],
    ]);
    expect(
      await app.inject({
        method: "POST",
        url: "/api/markdown-documents",
        payload: { folderId: "f1", title: "Note", body: "Body" },
      }),
    )
      .toMatchObject({ statusCode: 404 });
  });

  it("returns fixture 503 when no connected node declares board_yjs_host true", async () => {
    const registry = createRegistry();
    registerNode(registry, "worker-node", 4106, false);
    const httpClient: BoardYjsHostHttpClient = vi.fn();
    const app = createApp({
      config,
      boardYjsHostProxyRoutes: { registry, httpClient },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/board-yjs/host/update",
      payload: { update: "payload" },
    });

    expect(response.statusCode).toBe(fixture.cardinality.zeroHostsStatus);
    expect(response.json()).toMatchObject({
      error: { code: "BOARD_YJS_HOST_UNAVAILABLE" },
    });
    expect(httpClient).not.toHaveBeenCalled();
  });

  it("returns fixture 503 when two connected nodes declare board_yjs_host true", async () => {
    const registry = createRegistry();
    registerNode(registry, "board-host", 4105, true);
    registerNode(registry, "board-host-2", 4106, true);
    const httpClient: BoardYjsHostHttpClient = vi.fn();
    const app = createApp({
      config,
      boardYjsHostProxyRoutes: { registry, httpClient },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/board-yjs/host/update",
      payload: { update: "payload" },
    });

    expect(response.statusCode).toBe(fixture.cardinality.twoHostsStatus);
    expect(response.json()).toMatchObject({
      error: { code: "BOARD_YJS_HOST_AMBIGUOUS" },
    });
    expect(httpClient).not.toHaveBeenCalled();
  });

  it("proxies board-yjs host operation to the single connected host with authorization only", async () => {
    const registry = createRegistry();
    registerNode(registry, "worker-node", 4106, false);
    const disconnectedHostConnectionId = registerNode(registry, "old-board-host", 4107, true);
    registry.disconnectNode("old-board-host", {
      connectionId: disconnectedHostConnectionId,
      reason: "network close",
    });
    const connectionId = registerNode(registry, "board-host", 4105, true);
    const httpClient: BoardYjsHostHttpClient = vi.fn(async () => ({
      statusCode: fixture.cardinality.oneHostStatus,
      headers: { "content-type": "application/json" },
      body: { ok: true },
    }));
    const app = createApp({
      config,
      boardYjsHostProxyRoutes: { registry, httpClient },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/board-yjs/host/update",
      headers: {
        authorization: "Bearer test-token",
        "x-extra": "not-forwarded",
      },
      payload: { update: "payload" },
    });

    expect(response.statusCode).toBe(fixture.cardinality.oneHostStatus);
    expect(response.json()).toEqual({ ok: true });
    expect(httpClient).toHaveBeenCalledTimes(1);
    expect(httpClient).toHaveBeenCalledWith({
      method: "POST",
      url: "http://localhost:4105/api/internal/board-yjs/update",
      upstreamPath: "/api/internal/board-yjs/update",
      headers: { authorization: "Bearer test-token" },
      body: { update: "payload" },
      target: {
        host: "localhost",
        port: 4105,
        nodeId: "board-host",
        connectionId,
      },
    });
  });

  it("preserves non-JSON upstream status, content-type, and body", async () => {
    const registry = createRegistry();
    registerNode(registry, "board-host", 4105, true);
    const httpClient: BoardYjsHostHttpClient = vi.fn(async () => ({
      statusCode: 418,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: "teapot",
    }));
    const app = createApp({
      config,
      boardYjsHostProxyRoutes: { registry, httpClient },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/board-yjs/host/update",
      payload: { update: "payload" },
    });

    expect(response.statusCode).toBe(418);
    expect(response.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(response.body).toBe("teapot");
  });

  it("encodes board-yjs host operation path segment before proxying", async () => {
    const registry = createRegistry();
    registerNode(registry, "board-host", 4105, true);
    const httpClient: BoardYjsHostHttpClient = vi.fn(async () => ({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: { ok: true },
    }));
    const app = createApp({
      config,
      boardYjsHostProxyRoutes: { registry, httpClient },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/board-yjs/host/sync%2Fupdates",
      payload: { update: "payload" },
    });

    expect(response.statusCode).toBe(200);
    expect(httpClient).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        url: "http://localhost:4105/api/internal/board-yjs/sync%2Fupdates",
        upstreamPath: "/api/internal/board-yjs/sync%2Fupdates",
        body: { update: "payload" },
      }),
    );
  });

  it("maps upstream request failure to explicit 502", async () => {
    const registry = createRegistry();
    registerNode(registry, "board-host", 4105, true);
    const httpClient: BoardYjsHostHttpClient = vi.fn(async () => {
      throw new Error("network down");
    });
    const app = createApp({
      config,
      boardYjsHostProxyRoutes: { registry, httpClient },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/board-yjs/host/update",
      payload: { update: "payload" },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      error: {
        code: "BOARD_YJS_HOST_REQUEST_FAILED",
        nodeId: "board-host",
      },
    });
  });

  it("can be registered directly for focused route-boundary tests", async () => {
    const registry = createRegistry();
    const httpClient: BoardYjsHostHttpClient = vi.fn();
    const app = createApp({ config });

    registerBoardYjsHostProxyRoutes(app, { registry, httpClient });

    expect(
      await app.inject({
        method: "POST",
        url: "/api/board-yjs/host/update",
        payload: { update: "payload" },
      }),
    ).toMatchObject({ statusCode: 503 });
  });
});
