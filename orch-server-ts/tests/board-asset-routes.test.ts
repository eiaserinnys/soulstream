import { describe, expect, it } from "vitest";

import {
  BoardAssetRouteError,
  boardAssetRouteAuthRequirements,
  createApp,
  loadContractFixtures,
  parseOrchServerConfig,
  type BoardAssetAccessProvider,
  type BoardAssetCommitInput,
  type BoardAssetInitInput,
  type BoardAssetRouteProvider,
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
    id: "runbook:rb-1",
    folderId: "folder-a",
    itemType: "runbook",
    itemId: "rb-1",
  },
  {
    id: "runbook:rb-empty-folder",
    folderId: "",
    itemType: "runbook",
    itemId: "rb-empty-folder",
  },
  {
    id: "note:1",
    folderId: "folder-a",
    itemType: "markdown-document",
    itemId: "doc-1",
  },
];

type ProviderCall =
  | ["listFolders"]
  | ["access"]
  | ["catalog"]
  | ["init", BoardAssetInitInput]
  | ["commit", BoardAssetCommitInput];

function createHarness(overrides: Partial<BoardAssetRouteProvider> = {}) {
  const calls: ProviderCall[] = [];
  const provider: BoardAssetRouteProvider = {
    async listFolders() {
      calls.push(["listFolders"]);
      return folders;
    },
    async getCatalogSnapshot() {
      calls.push(["catalog"]);
      return { boardItems };
    },
    async initFileAsset(input) {
      calls.push(["init", input]);
      return {
        assetId: "asset-1",
        uploadMode: "single",
        uploadUrl: "https://r2.example/upload",
      };
    },
    async commitFileAsset(input) {
      calls.push(["commit", input]);
      return {
        asset: { id: input.assetId, uploadStatus: "committed" },
        boardItem: { id: `asset:${input.assetId}`, itemType: "asset" },
      };
    },
    ...overrides,
  };
  return { calls, provider };
}

function createAccessProvider(
  access: { restricted: boolean; allowedFolderIds?: string[] },
  calls: ProviderCall[],
): BoardAssetAccessProvider {
  return {
    async resolveAccess() {
      calls.push(["access"]);
      return access;
    },
  };
}

function createAppWithBoardAssets(
  access: { restricted: boolean; allowedFolderIds?: string[] },
  overrides: Partial<BoardAssetRouteProvider> = {},
) {
  const harness = createHarness(overrides);
  const app = createApp({
    config,
    boardAssetRoutes: {
      provider: harness.provider,
      accessProvider: createAccessProvider(access, harness.calls),
    },
  });
  return { app, calls: harness.calls };
}

describe("board asset route harness", () => {
  const fixtures = loadContractFixtures();

  it("keeps board asset routes disabled on the default app", async () => {
    const app = createApp({ config });

    for (const [method, url, payload] of [
      ["POST", "/api/board/folder-a/assets/init", { name: "photo.png", mime: "image/png", size: 123 }],
      [
        "POST",
        "/api/board-containers/runbook/rb-1/assets/init",
        { name: "photo.png", mime: "image/png", size: 123 },
      ],
      ["POST", "/api/board/folder-a/assets/asset-1/commit", { x: 1, y: 2 }],
      ["POST", "/api/board-containers/runbook/rb-1/assets/asset-1/commit", { x: 1, y: 2 }],
    ] as const) {
      expect(await app.inject({ method, url, payload })).toMatchObject({
        statusCode: 404,
      });
    }

    await app.close();
  });

  it("registers Python auth contract rows for route inventory order 82-85", () => {
    expect(boardAssetRouteAuthRequirements).toEqual({
      "POST /api/board/:folder_id/assets/init": true,
      "POST /api/board-containers/:container_kind/:container_id/assets/init": true,
      "POST /api/board/:folder_id/assets/:asset_id/commit": true,
      "POST /api/board-containers/:container_kind/:container_id/assets/:asset_id/commit": true,
    });

    const routeRows = fixtures.routeInventory.routes
      .filter((route) =>
        [
          "init_board_asset",
          "init_container_board_asset",
          "commit_board_asset",
          "commit_container_board_asset",
        ].includes(route.name),
      )
      .map((route) => [route.order, route.methods[0], route.path, route.authRequired]);

    expect(routeRows).toEqual([
      [82, "POST", "/api/board/{folder_id}/assets/init", true],
      [83, "POST", "/api/board-containers/{container_kind}/{container_id}/assets/init", true],
      [84, "POST", "/api/board/{folder_id}/assets/{asset_id}/commit", true],
      [
        85,
        "POST",
        "/api/board-containers/{container_kind}/{container_id}/assets/{asset_id}/commit",
        true,
      ],
    ]);
  });

  it("initializes folder assets after descendant folder access check", async () => {
    const { app, calls } = createAppWithBoardAssets({
      restricted: true,
      allowedFolderIds: ["folder-a"],
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/board/folder-a-child/assets/init",
      payload: { name: "photo.png", mime: "image/png", size: 123 },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      assetId: "asset-1",
      uploadMode: "single",
      uploadUrl: "https://r2.example/upload",
    });
    expect(calls).toEqual([
      ["listFolders"],
      ["access"],
      [
        "init",
        {
          folderId: "folder-a-child",
          name: "photo.png",
          mimeType: "image/png",
          byteSize: 123,
        },
      ],
    ]);

    await app.close();
  });

  it("resolves runbook containers from catalog board items before init", async () => {
    const { app, calls } = createAppWithBoardAssets({
      restricted: true,
      allowedFolderIds: ["folder-a"],
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/board-containers/runbook/rb-1/assets/init",
      payload: { name: "photo.png", mime: "image/png", size: 123 },
    });

    expect(response.statusCode).toBe(201);
    expect(calls).toEqual([
      ["catalog"],
      ["listFolders"],
      ["access"],
      [
        "init",
        {
          folderId: "folder-a",
          name: "photo.png",
          mimeType: "image/png",
          byteSize: 123,
          containerKind: "runbook",
          containerId: "rb-1",
        },
      ],
    ]);

    await app.close();
  });

  it("commits folder assets with metadata and multipart parts", async () => {
    const { app, calls } = createAppWithBoardAssets({
      restricted: false,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/board/folder-a/assets/asset-1/commit",
      payload: {
        x: 41,
        y: 79,
        width: 640,
        height: 480,
        durationSeconds: 3.5,
        parts: [
          { partNumber: 1, etag: "etag-1" },
          { partNumber: 2, etag: "etag-2" },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      asset: { id: "asset-1", uploadStatus: "committed" },
      boardItem: { id: "asset:asset-1", itemType: "asset" },
    });
    expect(calls).toEqual([
      ["listFolders"],
      ["access"],
      [
        "commit",
        {
          folderId: "folder-a",
          assetId: "asset-1",
          x: 41,
          y: 79,
          width: 640,
          height: 480,
          durationSeconds: 3.5,
          parts: [
            { partNumber: 1, etag: "etag-1" },
            { partNumber: 2, etag: "etag-2" },
          ],
        },
      ],
    ]);

    await app.close();
  });

  it("commits runbook container assets with default parts", async () => {
    const { app, calls } = createAppWithBoardAssets({
      restricted: true,
      allowedFolderIds: ["folder-a"],
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/board-containers/runbook/rb-1/assets/asset-1/commit",
      payload: { x: 41, y: 79 },
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([
      ["catalog"],
      ["listFolders"],
      ["access"],
      [
        "commit",
        {
          folderId: "folder-a",
          assetId: "asset-1",
          x: 41,
          y: 79,
          parts: [],
          containerKind: "runbook",
          containerId: "rb-1",
        },
      ],
    ]);

    await app.close();
  });

  it("rejects invalid or missing board containers before asset provider calls", async () => {
    const { app, calls } = createAppWithBoardAssets({ restricted: false });

    const invalidKind = await app.inject({
      method: "POST",
      url: "/api/board-containers/session/sess-1/assets/init",
      payload: { name: "photo.png", mime: "image/png", size: 123 },
    });
    const missingRunbook = await app.inject({
      method: "POST",
      url: "/api/board-containers/runbook/missing/assets/init",
      payload: { name: "photo.png", mime: "image/png", size: 123 },
    });

    expect(invalidKind.statusCode).toBe(400);
    expect(invalidKind.json()).toEqual({
      detail: "container_kind must be folder or runbook",
    });
    expect(missingRunbook.statusCode).toBe(404);
    expect(missingRunbook.json()).toEqual({
      detail: "Runbook board container not found",
    });
    expect(calls).toEqual([["catalog"]]);

    await app.close();
  });

  it("denies folder access before calling asset provider", async () => {
    const { app, calls } = createAppWithBoardAssets({
      restricted: true,
      allowedFolderIds: ["folder-a"],
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/board/folder-b/assets/init",
      payload: { name: "photo.png", mime: "image/png", size: 123 },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ detail: "Folder access denied" });
    expect(calls).toEqual([["listFolders"], ["access"]]);

    await app.close();
  });

  it("maps board asset provider errors like Python _board_asset_error", async () => {
    const storage = createAppWithBoardAssets(
      { restricted: false },
      {
        async initFileAsset() {
          throw new BoardAssetRouteError(
            "BOARD_ASSET_STORAGE_UNAVAILABLE",
            "board asset storage is not configured",
            503,
          );
        },
      },
    );
    const quota = createAppWithBoardAssets(
      { restricted: false },
      {
        async initFileAsset() {
          throw new Error("daily board asset quota exceeded");
        },
      },
    );
    const badAsset = createAppWithBoardAssets(
      { restricted: false },
      {
        async commitFileAsset() {
          throw new Error("file asset not found: asset-1");
        },
      },
    );

    const storageResponse = await storage.app.inject({
      method: "POST",
      url: "/api/board/folder-a/assets/init",
      payload: { name: "photo.png", mime: "image/png", size: 123 },
    });
    const quotaResponse = await quota.app.inject({
      method: "POST",
      url: "/api/board/folder-a/assets/init",
      payload: { name: "large.mov", mime: "video/quicktime", size: 999 },
    });
    const badAssetResponse = await badAsset.app.inject({
      method: "POST",
      url: "/api/board/folder-a/assets/asset-1/commit",
      payload: { x: 1, y: 2 },
    });

    expect(storageResponse.statusCode).toBe(503);
    expect(storageResponse.json()).toEqual({
      detail: "board asset storage is not configured",
    });
    expect(quotaResponse.statusCode).toBe(413);
    expect(quotaResponse.json()).toEqual({
      detail: "daily board asset quota exceeded",
    });
    expect(badAssetResponse.statusCode).toBe(400);
    expect(badAssetResponse.json()).toEqual({
      detail: "file asset not found: asset-1",
    });

    await storage.app.close();
    await quota.app.close();
    await badAsset.app.close();
  });
});
