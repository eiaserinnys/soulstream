import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import {
  createBoardYDocSnapshot,
  readBoardYDocReplica,
} from "../src/board-yjs/board_yjs_model.js";
import {
  createBoardYjsPersistence,
  type BoardYjsPersistenceRepository,
} from "../src/board-yjs/board_yjs_persistence.js";

describe("orch board Yjs persistence", () => {
  it("seeds a missing snapshot and marks it synced before destructive reconciliation", async () => {
    const scope = {
      folderId: "folder-1",
      containerKind: "folder" as const,
      containerId: "folder-1",
    };
    const repository = {
      getBoardYjsSnapshot: vi.fn().mockResolvedValue(null),
      resolveBoardYjsContainerScope: vi.fn().mockResolvedValue(scope),
      loadBoardYjsSeed: vi.fn().mockResolvedValue({
        boardItems: [{
          id: "session:s1",
          folderId: "folder-1",
          itemType: "session",
          itemId: "s1",
          x: 0,
          y: 0,
          metadata: {},
        }],
        markdownDocuments: [],
      }),
      storeBoardYjsSnapshot: vi.fn().mockResolvedValue(undefined),
      markBoardYjsDocumentSynced: vi.fn().mockResolvedValue(undefined),
    } as unknown as BoardYjsPersistenceRepository;
    const persistence = createBoardYjsPersistence(repository);

    const snapshot = await persistence.database.configuration.fetch?.({
      documentName: "board-folder:folder-1",
    } as never);

    const doc = new Y.Doc();
    Y.applyUpdate(doc, snapshot as Uint8Array);
    expect(readBoardYDocReplica(scope, doc).boardItems.map((item) => item.id))
      .toEqual(["session:s1"]);
    expect(vi.mocked(repository.storeBoardYjsSnapshot).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(repository.markBoardYjsDocumentSynced).mock.invocationCallOrder[0]!);
  });

  it("store derives the replica from the supplied Y.Doc state", async () => {
    const scope = {
      folderId: "folder-1",
      containerKind: "folder" as const,
      containerId: "folder-1",
    };
    const state = createBoardYDocSnapshot({
      ...scope,
      boardItems: [{
        id: "session:s1",
        folderId: "folder-1",
        itemType: "session",
        itemId: "s1",
        x: 280,
        y: 160,
        metadata: {},
      }],
      markdownDocuments: [],
    });
    const repository = {
      storeBoardYjsSnapshot: vi.fn().mockResolvedValue(undefined),
      resolveBoardYjsContainerScope: vi.fn().mockResolvedValue(scope),
      syncBoardYjsReplica: vi.fn().mockResolvedValue(undefined),
    } as unknown as BoardYjsPersistenceRepository;
    const persistence = createBoardYjsPersistence(repository);

    await persistence.database.configuration.store?.({
      documentName: "board-folder:folder-1",
      state,
    } as never);

    expect(repository.syncBoardYjsReplica).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        boardItems: [expect.objectContaining({ id: "session:s1", x: 280, y: 160 })],
      }),
      "board-folder:folder-1",
    );
  });
});
