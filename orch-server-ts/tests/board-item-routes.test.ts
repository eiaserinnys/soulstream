import { describe, expect, it, vi } from "vitest";

import {
  BoardItemRouteError,
  boardItemRouteAuthRequirements,
  createApp,
  loadContractFixtures,
  parseOrchServerConfig,
  type BoardItemAccessProvider,
  type BoardItemRouteProvider,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

const folders = [
  { id: "folder-a", parentFolderId: null, name: "Alpha" },
  { id: "folder-a-child", parentFolderId: "folder-a", name: "Child" },
  { id: "task-1", parentFolderId: "folder-a", name: "Checklist folder" },
  { id: "folder-b", parentFolderId: null, name: "Beta" },
];

const boardItems = [
  {
    id: "item/one",
    folderId: "folder-a-child",
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
    itemType: "subfolder",
    itemId: "task-1",
  },
  { id: "item-b", folderId: "folder-b" },
];

type ProviderCall =
  | ["access"]
  | ["listFolders"]
  | ["listBoardItems", unknown]
  | ["getBoardItemById", string]
  | ["catalog"]
  | ["resolveContainer", unknown];

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

    async getBoardItemById(boardItemId) {
      calls.push(["getBoardItemById", boardItemId]);
      return boardItems.find((item) => item.id === boardItemId) ?? null;
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
    moveBoardItem: vi.fn(async (id: string, folderId: string) => ({ ...boardItems.find(item => item.id === id), folderId })),
    ...serviceOverrides,
  };
  const app = createApp({
    config,
    boardItemRoutes: {
      provider: harness.provider,
      accessProvider,
      host: service as never,
    },
  });
  return { app, calls: harness.calls, service };
}

describe("board item route harness", () => {
  const fixtures = loadContractFixtures();

  it("keeps board item routes disabled on the default app", async () => {
    const app = createApp({ config });

    for (const [method, url, payload] of [
      ["GET", "/api/board-items?folderId=folder-a", undefined],
      ["PATCH", "/api/board-items/item-1/position", { x: 1, y: 2 }],
      [
        "PATCH",
        "/api/board-items/item-1/folder",
        { folderId: "folder-a", idempotencyKey: "idem" },
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
      "PATCH /api/board-items/:board_item_id/folder": true,
    });

    const routeRows = fixtures.routeInventory.routes
      .filter((route) =>
        [
          "list_board_items",
          "move_board_item_to_folder",
        ].includes(route.name),
      )
      .map((route) => [route.order, route.methods[0], route.path, route.authRequired]);

    expect(routeRows).toEqual([
      [70, "GET", "/api/board-items", true],
      [72, "PATCH", "/api/board-items/{board_item_id}/folder", true],
    ]);
  });

  it("rejects ambiguous board item list query shapes", async () => {
    const { app, calls } = createAppWithBoardItems({ restricted: false });

    const missing = await app.inject({ method: "GET", url: "/api/board-items" });
    const mixed = await app.inject({
      method: "GET",
      url: "/api/board-items?folderId=folder-a&container_kind=folder&container_id=folder-a",
    });
    const invalidKind = await app.inject({
      method: "GET",
      url: "/api/board-items?container_kind=session&container_id=sess-1",
    });

    expect(missing.statusCode).toBe(400);
    expect(mixed.statusCode).toBe(400);
    expect(invalidKind.statusCode).toBe(400);
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
      url: "/api/board-items?folderId=folder-a-child",
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

  it("rejects retired container query aliases", async () => {
    const { app, calls } = createAppWithBoardItems({ restricted: false });
    const response = await app.inject({ method: "GET", url: "/api/board-items?container_kind=task&container_id=task-1" });
    expect(response.statusCode).toBe(400);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("looks up a primary session membership without relying on a loaded folder page", async () => {
    const membership = {
      id: "session:session-a",
      folderId: "folder-a",
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
      url: "/api/board-items?sessionId=session-a",
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

  it("moves board items to containers with idempotency key and optional coordinates", async () => {
    const { app, calls, service } = createAppWithBoardItems({
      restricted: true,
      allowedFolderIds: ["folder-a"],
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/board-items/item%2Fone/folder",
      payload: {
        folderId: "task-1",
        idempotencyKey: "idem-1",
        x: 2,
        y: 3,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([
      ["access"],
      ["listFolders"],
      ["getBoardItemById", "item/one"],
    ]);
    expect(service.moveBoardItem).toHaveBeenCalledWith("item/one", "task-1", "idem-1");

    await app.close();
  });

  it.each([
    { label: "source", allowedFolderIds: ["folder-b"] },
    { label: "target", allowedFolderIds: ["folder-a"] },
  ])("preserves restricted $label folder checks before moving", async ({ allowedFolderIds }) => {
    const { app, calls, service } = createAppWithBoardItems({
      restricted: true,
      allowedFolderIds,
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/board-items/item%2Fone/folder",
      payload: { folderId: "folder-b", idempotencyKey: "idem-denied" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ detail: "Folder access denied" });
    expect(calls).toEqual([
      ["access"],
      ["listFolders"],
      ["getBoardItemById", "item/one"],
    ]);
    expect(service.moveBoardItem).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns the board item produced by the orchestrator-local service", async () => {
    const moved = { ...boardItems[0], folderId: "task-1" };
    const moveBoardItem = vi.fn(async () => moved);
    const { app } = createAppWithBoardItems(
      { restricted: false },
      {},
      { moveBoardItem },
    );

    const response = await app.inject({
      method: "PATCH",
      url: "/api/board-items/item%2Fone/folder",
      payload: {
        folderId: "task-1",
        idempotencyKey: "idem-local",
        x: 3,
        y: 4,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, boardItem: moved });
    expect(moveBoardItem).toHaveBeenCalledWith("item/one", "task-1", "idem-local");
    await app.close();
  });

  it("rejects partial container move coordinates before host proxy", async () => {
    const { app, service } = createAppWithBoardItems({ restricted: false });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/board-items/item%2Fone/folder",
      payload: {
        folderId: "folder-a",
        idempotencyKey: "idem-1",
        x: 2,
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      detail: expect.stringContaining("x and y must be supplied together"),
    });
    expect(service.moveBoardItem).not.toHaveBeenCalled();

    await app.close();
  });

});
