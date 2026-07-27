import { describe, expect, it, vi } from "vitest";

import {
  InMemorySseReplayBroadcaster,
  withSessionCatalogMutationBroadcasts,
  type LiveFolderProvider,
  type SessionCatalogProvider,
  type SessionStreamEvent,
} from "../src/index.js";

describe("withSessionCatalogMutationBroadcasts", () => {
  it("emits targeted upserts for rename/move/update and null only for deletion", async () => {
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

    expect(broadcaster.bufferedEvents.map((event) => event.payload)).toEqual([
      catalogUpdatedPayload({
        "sess-a": { folderId: "folder-b", displayName: "Renamed" },
      }),
      catalogUpdatedPayload({
        "sess-a": { folderId: "folder-b", displayName: "Renamed" },
      }),
      catalogUpdatedPayload({
        "sess-a": { folderId: "folder-b", displayName: "Renamed" },
      }),
      catalogUpdatedPayload(
        { "sess-a": null },
        { "session:sess-a": null },
      ),
    ]);
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

function createFolderProvider(): LiveFolderProvider {
  return {
    listFolders: vi.fn(async () => [{ id: "folder-a", name: "Folder A" }]),
    listSessionAssignments: vi.fn(async () => ({
      "sess-a": { folderId: "folder-a", displayName: "Renamed" },
    })),
    listSessionAssignmentsByIds: vi.fn(async (sessionIds: readonly string[]) =>
      Object.fromEntries(sessionIds.map((sessionId) => [
        sessionId,
        { folderId: "folder-b", displayName: "Renamed" },
      ])),
    ),
    deleteFolderWithCatalogDelta: vi.fn(async () => ({
      sessionsDelta: {},
      deletedBoardItemIds: [],
    })),
    listBoardItemIdsForSessionDeletion: vi.fn(async () => ["session:sess-a"]),
    findSessionFolderId: vi.fn(async () => "folder-a"),
    createFolder: vi.fn(async () => undefined),
    updateFolder: vi.fn(async () => undefined),
    deleteFolder: vi.fn(async () => undefined),
    reorderFolders: vi.fn(async () => undefined),
    getFolderCounts: vi.fn(async () => new Map()),
  };
}

function catalogUpdatedPayload(
  sessionsDelta: Record<string, unknown>,
  boardItemsDelta: Record<string, unknown> = {},
): SessionStreamEvent {
  return {
    type: "catalog_updated",
    folders: [{ id: "folder-a", name: "Folder A" }],
    sessions_delta: sessionsDelta,
    board_items_delta: boardItemsDelta,
  };
}
