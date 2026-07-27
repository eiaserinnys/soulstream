import { describe, expect, it, vi } from "vitest";

import {
  InMemorySseReplayBroadcaster,
  withFolderMutationBroadcasts,
  type LiveFolderProvider,
  type SessionStreamEvent,
} from "../src/index.js";

describe("withFolderMutationBroadcasts", () => {
  it("always emits both delta keys and distinguishes folder unassignment from deletion", async () => {
    const broadcaster = new InMemorySseReplayBroadcaster<SessionStreamEvent>();
    const provider = withFolderMutationBroadcasts(createProvider(), broadcaster);

    await provider.createFolder("New", 1, { parentFolderId: null });
    await provider.updateFolder("folder-a", { name: "Renamed" });
    await provider.deleteFolder("folder-a");
    await provider.reorderFolders([{ id: "folder-b", sortOrder: 2 }]);

    expect(broadcaster.bufferedEvents).toHaveLength(4);
    expect(broadcaster.bufferedEvents.map((event) => event.payload)).toEqual([
      catalogUpdatedPayload(),
      catalogUpdatedPayload(),
      catalogUpdatedPayload({
        sessions_delta: {
          "sess-a": { folderId: null, displayName: "Session A" },
        },
        board_items_delta: {
          "session:sess-a": null,
        },
      }),
      catalogUpdatedPayload(),
    ]);
  });

  it("does not broadcast when a mutation fails", async () => {
    const broadcaster = new InMemorySseReplayBroadcaster<SessionStreamEvent>();
    const provider = createProvider();
    provider.updateFolder = vi.fn(async () => {
      throw new Error("folder write failed");
    });
    const wrapped = withFolderMutationBroadcasts(provider, broadcaster);

    await expect(wrapped.updateFolder("folder-a", { name: "Renamed" }))
      .rejects.toThrow("folder write failed");

    expect(broadcaster.bufferedEvents).toEqual([]);
  });
});

function createProvider(): LiveFolderProvider {
  return {
    listFolders: vi.fn(async () => [
      {
        id: "folder-a",
        name: "Folder",
        sortOrder: 1,
        parentFolderId: null,
        settings: {},
      },
    ]),
    listSessionAssignments: vi.fn(async () => ({
      "sess-a": { folderId: "folder-a" },
    })),
    listSessionAssignmentsByIds: vi.fn(async () => ({})),
    deleteFolderWithCatalogDelta: vi.fn(async () => ({
      sessionsDelta: {
        "sess-a": { folderId: null, displayName: "Session A" },
      },
      deletedBoardItemIds: ["session:sess-a"],
    })),
    listBoardItemIdsForSessionDeletion: vi.fn(async () => []),
    findSessionFolderId: vi.fn(async () => "folder-a"),
    createFolder: vi.fn(async () => ({
      id: "folder-new",
      name: "New",
      sortOrder: 1,
      parentFolderId: null,
      settings: {},
    })),
    updateFolder: vi.fn(async () => undefined),
    deleteFolder: vi.fn(async () => undefined),
    reorderFolders: vi.fn(async () => undefined),
    getFolderCounts: vi.fn(async () => new Map()),
  };
}

function catalogUpdatedPayload(
  overrides: Partial<SessionStreamEvent> = {},
): SessionStreamEvent {
  return {
    type: "catalog_updated",
    folders: [
      {
        id: "folder-a",
        name: "Folder",
        sortOrder: 1,
        parentFolderId: null,
        settings: {},
      },
    ],
    sessions_delta: {},
    board_items_delta: {},
    ...overrides,
  };
}
