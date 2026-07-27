import { describe, expect, it, vi } from "vitest";

import {
  withBoardAssetMutationBroadcasts,
  type BoardAssetRouteProvider,
  type LiveFolderProvider,
} from "../src/index.js";

describe("live board asset mutation broadcaster", () => {
  it("emits catalog_updated after committed asset catalog mutation", async () => {
    const provider: BoardAssetRouteProvider = {
      listFolders: vi.fn(async () => []),
      getCatalogSnapshot: vi.fn(async () => ({ boardItems: [] })),
      initFileAsset: vi.fn(async () => ({ assetId: "asset-1" })),
      commitFileAsset: vi.fn(async () => ({
        asset: {},
        boardItem: {
          id: "asset:asset-1",
          folderId: "folder-a",
          itemType: "asset",
          itemId: "asset-1",
          x: 0,
          y: 0,
          metadata: {},
        },
      })),
    };
    const folderProvider = {
      listFolders: vi.fn(async () => [{ id: "folder-a" }]),
      listSessionAssignments: vi.fn(async () => ({
        "sess-1": { folderId: "folder-a" },
      })),
      listSessionAssignmentsByIds: vi.fn(async () => ({})),
      deleteFolderWithCatalogDelta: vi.fn(async () => ({
        sessionsDelta: {},
        deletedBoardItemIds: [],
      })),
      listBoardItemIdsForSessionDeletion: vi.fn(async () => []),
      findSessionFolderId: vi.fn(async () => "folder-a"),
      createFolder: vi.fn(),
      updateFolder: vi.fn(),
      deleteFolder: vi.fn(),
      reorderFolders: vi.fn(),
      getFolderCounts: vi.fn(async () => new Map()),
    } satisfies LiveFolderProvider;
    const broadcaster = { append: vi.fn() };

    await withBoardAssetMutationBroadcasts(
      provider,
      folderProvider,
      broadcaster as never,
    ).commitFileAsset({
      folderId: "folder-a",
      assetId: "asset-1",
      x: 0,
      y: 0,
      parts: [],
    });

    expect(broadcaster.append).toHaveBeenCalledWith({
      type: "catalog_updated",
      folders: [{ id: "folder-a" }],
      sessions_delta: {},
      board_items_delta: {
        "asset:asset-1": {
          id: "asset:asset-1",
          folderId: "folder-a",
          itemType: "asset",
          itemId: "asset-1",
          x: 0,
          y: 0,
          metadata: {},
        },
      },
    });
  });
});
