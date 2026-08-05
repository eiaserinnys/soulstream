import { describe, expect, it, vi } from "vitest";

import {
  BoardItemRouteError,
  boardItemRouteAuthRequirements,
  createApp,
  loadContractFixtures,
  parseOrchServerConfig,
  type BoardItemAccessProvider,
  type BoardItemRouteProvider,
  type BoardYjsHostProxyRouteOptions,
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
    containerKind: "folder",
    containerId: "folder-a-child",
    membershipKind: "primary",
    itemType: "markdown",
    itemId: "doc-1",
    x: 1,
    y: 2,
    metadata: { title: "Doc" },
  },
  {
    id: "task-card",
    folderId: "folder-a",
    itemType: "task",
    itemId: "task-1",
  },
  { id: "item-b", folderId: "folder-b" },
];

type ProviderCall =
  | ["access"]
  | ["listFolders"]
  | ["listBoardItems", unknown]
  | ["resolveContainer", unknown]
  | ["catalog"];

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
      if (container.id === "task-1") return "folder-a";
      throw new BoardItemRouteError(
        "BOARD_CONTAINER_NOT_FOUND",
        "Task board container not found",
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
  serviceOverrides: Record<string, unknown> = {},
) {
  const harness = createHarness(overrides);
  const accessProvider = createAccessProvider(access, harness.calls);
  const service = {
    updateBoardItemPosition: vi.fn(async () => undefined),
    moveBoardItemToContainer: vi.fn(async (input) => input.boardItem),
    ...serviceOverrides,
  } as unknown as NonNullable<BoardYjsHostProxyRouteOptions["service"]>;
  const app = createApp({
    config,
    boardItemRoutes: {
      provider: harness.provider,
      accessProvider,
      hostProxy: { authBearerToken: "test-token", service },
    },
  });
  return { app, calls: harness.calls, service };
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
      detail: "folder_id, session_id, or container_kind/container_id is required",
    });
    expect(mixed.statusCode).toBe(400);
    expect(mixed.json()).toEqual({
      detail: "folder_id, session_id, and container_kind/container_id are mutually exclusive",
    });
    expect(invalidKind.statusCode).toBe(400);
    expect(invalidKind.json()).toEqual({
      detail: "container_kind must be folder or task",
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

  it("resolves task container folder before listing board items", async () => {
    const { app, calls } = createAppWithBoardItems({
      restricted: true,
      allowedFolderIds: ["folder-a"],
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/board-items?container_kind=task&container_id=task-1",
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([
      ["listFolders"],
      ["resolveContainer", { kind: "task", id: "task-1" }],
      ["access"],
      ["listBoardItems", { container: { kind: "task", id: "task-1" } }],
    ]);

    await app.close();
  });

  it("looks up a primary session membership without relying on a loaded folder page", async () => {
    const membership = {
      id: "session:session-a",
      folderId: "folder-a",
      containerKind: "task",
      containerId: "task-outside-page",
      membershipKind: "primary",
      itemType: "session",
      itemId: "session-a",
      x: 0,
      y: 0,
    };
    const { app, calls } = createAppWithBoardItems({
      restricted: true,
      allowedFolderIds: ["folder-a"],
    }, {
      async listBoardItems(query) {
        calls.push(["listBoardItems", query]);
        return [membership];
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/board-items?session_id=session-a",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ boardItems: [membership] });
    expect(calls).toEqual([
      ["listFolders"],
      ["listBoardItems", { sessionId: "session-a" }],
      ["access"],
    ]);
    await app.close();
  });

  it("updates restricted board positions locally after source item access check", async () => {
    const { app, calls, service } = createAppWithBoardItems({
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
    expect(calls).toEqual([["access"], ["catalog"], ["catalog"]]);
    expect(service.updateBoardItemPosition).toHaveBeenCalledWith(
      { containerKind: "folder", containerId: "folder-a-child" },
      "item/one",
      10.5,
      -3,
    );

    await app.close();
  });

  it("updates unrestricted positions through the same local service", async () => {
    const { app, calls, service } = createAppWithBoardItems({
      restricted: false,
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/board-items/item%2Fone/position",
      payload: { x: 1, y: 2 },
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([["access"], ["catalog"]]);
    expect(service.updateBoardItemPosition).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("returns Python-compatible 404 when restricted source item is absent", async () => {
    const { app, service } = createAppWithBoardItems(
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
    expect(service.updateBoardItemPosition).not.toHaveBeenCalled();

    await app.close();
  });

  it("moves board items to containers with idempotency alias and optional coordinates", async () => {
    const { app, calls, service } = createAppWithBoardItems({
      restricted: true,
      allowedFolderIds: ["folder-a"],
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/board-items/item%2Fone/container",
      payload: {
        container: { kind: "task", id: "task-1" },
        idempotency_key: "idem-1",
        x: 2,
        y: 3,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([
      ["access"],
      ["catalog"],
      ["resolveContainer", { kind: "task", id: "task-1" }],
    ]);
    expect(service.moveBoardItemToContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        targetScope: { folderId: "folder-a", containerKind: "task", containerId: "task-1" },
        idempotencyKey: "idem-1",
        position: { x: 2, y: 3 },
      }),
    );

    await app.close();
  });

  it("returns the board item produced by the orchestrator-local service", async () => {
    const moved = { ...boardItems[0], containerKind: "task", containerId: "task-1" };
    const moveBoardItemToContainer = vi.fn(async () => moved);
    const { app } = createAppWithBoardItems(
      { restricted: false },
      {},
      { moveBoardItemToContainer },
    );

    const response = await app.inject({
      method: "PATCH",
      url: "/api/board-items/item%2Fone/container",
      payload: {
        container: { kind: "task", id: "task-1" },
        idempotencyKey: "idem-local",
        x: 3,
        y: 4,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, boardItem: moved });
    expect(moveBoardItemToContainer).toHaveBeenCalledWith(expect.objectContaining({
      targetScope: { folderId: "folder-a", containerKind: "task", containerId: "task-1" },
      position: { x: 3, y: 4 },
    }));
    await app.close();
  });

  it("rejects partial container move coordinates before host proxy", async () => {
    const { app, service } = createAppWithBoardItems({ restricted: false });

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
    expect(service.moveBoardItemToContainer).not.toHaveBeenCalled();

    await app.close();
  });

  it("maps orchestrator-local mutation failures to the board-yjs error envelope", async () => {
    const updateBoardItemPosition = vi.fn(async () => {
      throw new Error("network down");
    });
    const { app } = createAppWithBoardItems(
      { restricted: false },
      {},
      { updateBoardItemPosition },
    );

    const response = await app.inject({
      method: "PATCH",
      url: "/api/board-items/item%2Fone/position",
      payload: { x: 1, y: 2 },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      error: {
        code: "BOARD_YJS_HOST_OPERATION_FAILED",
      },
    });

    await app.close();
  });
});
