import { describe, expect, it, vi } from "vitest";

import {
  InMemoryNodeRegistry,
  BoardItemRouteError,
  boardItemRouteAuthRequirements,
  createApp,
  loadContractFixtures,
  parseOrchServerConfig,
  type BoardItemAccessProvider,
  type BoardItemRouteProvider,
  type BoardYjsHostHttpClient,
  type NodeRegistrationPayload,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

const folders = [
  { id: "folder-a", parentFolderId: null, name: "Alpha" },
  { id: "folder-a-child", parentFolderId: "folder-a", name: "Child" },
  { id: "folder-b", parentFolderId: null, name: "Beta" },
];

const boardItems = [
  {
    id: "item/one",
    folderId: "folder-a-child",
    container: { kind: "folder", id: "folder-a-child" },
  },
  {
    id: "runbook-card",
    folderId: "folder-a",
    itemType: "runbook",
    itemId: "runbook-1",
  },
  { id: "item-b", folderId: "folder-b" },
];

type ProviderCall =
  | ["access"]
  | ["listFolders"]
  | ["listBoardItems", unknown]
  | ["resolveContainer", unknown]
  | ["catalog"];

function createRegistry(): InMemoryNodeRegistry {
  return new InMemoryNodeRegistry({
    nowMs: () => 1_700_000_000_000,
  });
}

function registerBoardHost(registry: InMemoryNodeRegistry): string {
  return registry.registerNode({
    type: "node_register",
    node_id: "board-host",
    host: "localhost",
    port: 4105,
    agents: [],
    capabilities: { board_yjs_host: true },
  } satisfies NodeRegistrationPayload).node.connectionId;
}

function createHarness(overrides: Partial<BoardItemRouteProvider> = {}) {
  const calls: ProviderCall[] = [];
  const provider: BoardItemRouteProvider = {
    async listFolders() {
      calls.push(["listFolders"]);
      return folders;
    },
    async listBoardItems(query) {
      calls.push(["listBoardItems", query]);
      return [{ id: "item-1", folderId: "folder-a" }];
    },
    async resolveBoardContainerFolderId(container) {
      calls.push(["resolveContainer", container]);
      if (container.kind === "folder") return container.id;
      if (container.id === "runbook-1") return "folder-a";
      throw new BoardItemRouteError(
        "BOARD_CONTAINER_NOT_FOUND",
        "Runbook board container not found",
        404,
      );
    },
    async getCatalogSnapshot() {
      calls.push(["catalog"]);
      return { folders, boardItems };
    },
    ...overrides,
  };
  return { calls, provider };
}

function createAccessProvider(
  access: { restricted: boolean; allowedFolderIds?: string[] },
  calls: ProviderCall[],
): BoardItemAccessProvider {
  return {
    async resolveAccess() {
      calls.push(["access"]);
      return access;
    },
  };
}

function createAppWithBoardItems(
  access: { restricted: boolean; allowedFolderIds?: string[] },
  overrides: Partial<BoardItemRouteProvider> = {},
  httpClient: BoardYjsHostHttpClient = vi.fn(async () => ({
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: { ok: true },
  })),
) {
  const registry = createRegistry();
  const connectionId = registerBoardHost(registry);
  const harness = createHarness(overrides);
  const accessProvider = createAccessProvider(access, harness.calls);
  const app = createApp({
    config,
    boardItemRoutes: {
      provider: harness.provider,
      accessProvider,
      hostProxy: { registry, httpClient },
    },
  });
  return { app, calls: harness.calls, connectionId, httpClient };
}

describe("board item route harness", () => {
  const fixtures = loadContractFixtures();

  it("keeps board item routes disabled on the default app", async () => {
    const app = createApp({ config });

    for (const [method, url, payload] of [
      ["GET", "/api/board-items?folder_id=folder-a", undefined],
      ["PATCH", "/api/board-items/item-1/position", { x: 1, y: 2 }],
      [
        "PATCH",
        "/api/board-items/item-1/container",
        { container: { kind: "folder", id: "folder-a" }, idempotencyKey: "idem" },
      ],
    ] as const) {
      expect(await app.inject({ method, url, payload })).toMatchObject({
        statusCode: 404,
      });
    }

    await app.close();
  });

  it("registers Python auth contract rows for route inventory order 70-72", () => {
    expect(boardItemRouteAuthRequirements).toEqual({
      "GET /api/board-items": true,
      "PATCH /api/board-items/:board_item_id/position": true,
      "PATCH /api/board-items/:board_item_id/container": true,
    });

    const routeRows = fixtures.routeInventory.routes
      .filter((route) =>
        [
          "list_board_items",
          "update_board_item_position",
          "move_board_item_to_container",
        ].includes(route.name),
      )
      .map((route) => [route.order, route.methods[0], route.path, route.authRequired]);

    expect(routeRows).toEqual([
      [70, "GET", "/api/board-items", true],
      [71, "PATCH", "/api/board-items/{board_item_id}/position", true],
      [72, "PATCH", "/api/board-items/{board_item_id}/container", true],
    ]);
  });

  it("rejects ambiguous board item list query shapes", async () => {
    const { app, calls } = createAppWithBoardItems({ restricted: false });

    const missing = await app.inject({ method: "GET", url: "/api/board-items" });
    const mixed = await app.inject({
      method: "GET",
      url: "/api/board-items?folder_id=folder-a&container_kind=folder&container_id=folder-a",
    });
    const invalidKind = await app.inject({
      method: "GET",
      url: "/api/board-items?container_kind=session&container_id=sess-1",
    });

    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toEqual({
      detail: "folder_id or container_kind/container_id is required",
    });
    expect(mixed.statusCode).toBe(400);
    expect(mixed.json()).toEqual({
      detail: "folder_id and container_kind/container_id are mutually exclusive",
    });
    expect(invalidKind.statusCode).toBe(400);
    expect(invalidKind.json()).toEqual({
      detail: "container_kind must be folder or runbook",
    });
    expect(calls).toEqual([]);

    await app.close();
  });

  it("lists folder scoped board items after descendant access check", async () => {
    const { app, calls } = createAppWithBoardItems({
      restricted: true,
      allowedFolderIds: ["folder-a"],
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/board-items?folder_id=folder-a-child",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      boardItems: [{ id: "item-1", folderId: "folder-a" }],
    });
    expect(calls).toEqual([
      ["listFolders"],
      ["access"],
      ["listBoardItems", { folderId: "folder-a-child" }],
    ]);

    await app.close();
  });

  it("resolves runbook container folder before listing board items", async () => {
    const { app, calls } = createAppWithBoardItems({
      restricted: true,
      allowedFolderIds: ["folder-a"],
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/board-items?container_kind=runbook&container_id=runbook-1",
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([
      ["listFolders"],
      ["resolveContainer", { kind: "runbook", id: "runbook-1" }],
      ["access"],
      ["listBoardItems", { container: { kind: "runbook", id: "runbook-1" } }],
    ]);

    await app.close();
  });

  it("proxies restricted position updates after source item access check", async () => {
    const { app, calls, connectionId, httpClient } = createAppWithBoardItems({
      restricted: true,
      allowedFolderIds: ["folder-a"],
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/board-items/item%2Fone/position",
      headers: {
        authorization: "Bearer test-token",
        "x-extra": "not-forwarded",
      },
      payload: { x: 10.5, y: -3 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(calls).toEqual([["access"], ["catalog"]]);
    expect(httpClient).toHaveBeenCalledWith({
      method: "PATCH",
      url: "http://localhost:4105/api/board-items/item%2Fone/position",
      upstreamPath: "/api/board-items/item%2Fone/position",
      headers: { authorization: "Bearer test-token" },
      body: { x: 10.5, y: -3 },
      target: {
        host: "localhost",
        port: 4105,
        nodeId: "board-host",
        connectionId,
      },
    });

    await app.close();
  });

  it("proxies unrestricted position updates without source lookup", async () => {
    const { app, calls, httpClient } = createAppWithBoardItems({
      restricted: false,
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/board-items/missing/position",
      payload: { x: 1, y: 2 },
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([["access"]]);
    expect(httpClient).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("returns Python-compatible 404 when restricted source item is absent", async () => {
    const { app, httpClient } = createAppWithBoardItems(
      {
        restricted: true,
        allowedFolderIds: ["folder-a"],
      },
      {
        async getCatalogSnapshot() {
          return { folders, boardItems: [] };
        },
      },
    );

    const response = await app.inject({
      method: "PATCH",
      url: "/api/board-items/missing/position",
      payload: { x: 1, y: 2 },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ detail: "Board item not found" });
    expect(httpClient).not.toHaveBeenCalled();

    await app.close();
  });

  it("moves board items to containers with idempotency alias and optional coordinates", async () => {
    const { app, calls, httpClient } = createAppWithBoardItems({
      restricted: true,
      allowedFolderIds: ["folder-a"],
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/board-items/item%2Fone/container",
      payload: {
        container: { kind: "runbook", id: "runbook-1" },
        idempotency_key: "idem-1",
        x: 2,
        y: 3,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([
      ["access"],
      ["catalog"],
      ["resolveContainer", { kind: "runbook", id: "runbook-1" }],
    ]);
    expect(httpClient).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "PATCH",
        upstreamPath: "/api/board-items/item%2Fone/container",
        body: {
          container: { kind: "runbook", id: "runbook-1" },
          idempotencyKey: "idem-1",
          x: 2,
          y: 3,
        },
      }),
    );

    await app.close();
  });

  it("rejects partial container move coordinates before host proxy", async () => {
    const { app, httpClient } = createAppWithBoardItems({ restricted: false });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/board-items/item%2Fone/container",
      payload: {
        container: { kind: "folder", id: "folder-a" },
        idempotencyKey: "idem-1",
        x: 2,
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      detail: "x and y must be supplied together",
    });
    expect(httpClient).not.toHaveBeenCalled();

    await app.close();
  });

  it("preserves non-JSON upstream position response", async () => {
    const httpClient: BoardYjsHostHttpClient = vi.fn(async () => ({
      statusCode: 418,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: "teapot",
    }));
    const { app } = createAppWithBoardItems({ restricted: false }, {}, httpClient);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/board-items/item-1/position",
      payload: { x: 1, y: 2 },
    });

    expect(response.statusCode).toBe(418);
    expect(response.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(response.body).toBe("teapot");

    await app.close();
  });

  it("maps host request failure to the existing board-yjs proxy error envelope", async () => {
    const httpClient: BoardYjsHostHttpClient = vi.fn(async () => {
      throw new Error("network down");
    });
    const { app } = createAppWithBoardItems({ restricted: false }, {}, httpClient);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/board-items/item-1/position",
      payload: { x: 1, y: 2 },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      error: {
        code: "BOARD_YJS_HOST_REQUEST_FAILED",
        nodeId: "board-host",
      },
    });

    await app.close();
  });
});
