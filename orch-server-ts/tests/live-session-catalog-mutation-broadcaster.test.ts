import { describe, expect, it, vi } from "vitest";

import {
  InMemorySseReplayBroadcaster,
  withSessionCatalogMutationBroadcasts,
  type FolderRouteProvider,
  type SessionCatalogProvider,
  type SessionStreamEvent,
} from "../src/index.js";

describe("withSessionCatalogMutationBroadcasts", () => {
  it("appends catalog_updated after title and placement mutations", async () => {
    const broadcaster = new InMemorySseReplayBroadcaster<SessionStreamEvent>();
    const provider = createSessionProvider();
    const wrapped = withSessionCatalogMutationBroadcasts(
      provider,
      createFolderProvider(),
      broadcaster,
    );

    await wrapped.renameSession("sess-a", "Renamed");
    await wrapped.moveSessionsToFolder(["sess-a"], "folder-b");
    await wrapped.updateSessionCatalog("sess-a", { displayName: "Updated" });
    await wrapped.deleteSession("sess-a");

    expect(broadcaster.bufferedEvents.map((event) => event.payload)).toEqual(
      Array.from({ length: 4 }, () => catalogUpdatedPayload()),
    );
  });

  it("does not broadcast for reads or failed mutations", async () => {
    const broadcaster = new InMemorySseReplayBroadcaster<SessionStreamEvent>();
    const provider = createSessionProvider();
    provider.renameSession = vi.fn(async () => {
      throw new Error("rename failed");
    });
    const wrapped = withSessionCatalogMutationBroadcasts(
      provider,
      createFolderProvider(),
      broadcaster,
    );

    await wrapped.getSessionCards("sess-a");
    await wrapped.updateReadPosition("sess-a", 17);
    await expect(wrapped.renameSession("sess-a", "Broken")).rejects.toThrow("rename failed");

    expect(broadcaster.bufferedEvents).toEqual([]);
  });
});

function createSessionProvider(): SessionCatalogProvider {
  return {
    renameSession: vi.fn(async () => undefined),
    moveSessionsToFolder: vi.fn(async () => ({ count: 1 })),
    updateSessionCatalog: vi.fn(async () => undefined),
    deleteSession: vi.fn(async () => undefined),
    getSessionCards: vi.fn(async () => []),
    updateReadPosition: vi.fn(async () => undefined),
  };
}

function createFolderProvider(): FolderRouteProvider {
  return {
    listFolders: vi.fn(async () => [{ id: "folder-a", name: "Folder A" }]),
    listSessionAssignments: vi.fn(async () => ({
      "sess-a": { folderId: "folder-a", displayName: "Renamed" },
    })),
    createFolder: vi.fn(async () => undefined),
    updateFolder: vi.fn(async () => undefined),
    deleteFolder: vi.fn(async () => undefined),
    reorderFolders: vi.fn(async () => undefined),
  };
}

function catalogUpdatedPayload(): SessionStreamEvent {
  return {
    type: "catalog_updated",
    catalog: {
      folders: [{ id: "folder-a", name: "Folder A" }],
      sessions: {
        "sess-a": { folderId: "folder-a", displayName: "Renamed" },
      },
    },
  };
}
