import { describe, expect, it, vi } from "vitest";

import {
  InMemorySseReplayBroadcaster,
  withFolderMutationBroadcasts,
  type FolderRouteProvider,
  type SessionStreamEvent,
} from "../src/index.js";

describe("withFolderMutationBroadcasts", () => {
  it("appends catalog_updated after folder mutations", async () => {
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
      catalogUpdatedPayload(),
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

function createProvider(): FolderRouteProvider {
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
  };
}

function catalogUpdatedPayload(): SessionStreamEvent {
  return {
    type: "catalog_updated",
    catalog: {
      folders: [
        {
          id: "folder-a",
          name: "Folder",
          sortOrder: 1,
          parentFolderId: null,
          settings: {},
        },
      ],
      sessions: {
        "sess-a": { folderId: "folder-a" },
      },
    },
  };
}
