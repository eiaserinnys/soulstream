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
      commitFileAsset: vi.fn(async () => ({ asset: {}, boardItem: {} })),
    };
    const folderProvider = {
      listFolders: vi.fn(async () => [{ id: "folder-a" }]),
      listSessionAssignments: vi.fn(async () => ({
        "sess-1": { folderId: "folder-a" },
      })),
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
      catalog: {
        folders: [{ id: "folder-a" }],
        sessions: { "sess-1": { folderId: "folder-a" } },
      },
    });
  });
});
