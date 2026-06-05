import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { createBoardYjsPersistence } from "../../src/collaboration/board_yjs_persistence.js";
import {
  createBoardYDocSnapshot,
  getBoardYjsDocumentName,
  readBoardYDocReplica,
} from "../../src/collaboration/board_yjs_model.js";
import type { SessionDB } from "../../src/db/session_db.js";

describe("board_yjs_persistence", () => {
  it("onChange stores update, writes compact snapshot, syncs replica, and invalidates catalog cache", async () => {
    const folderId = "folder-1";
    const documentName = getBoardYjsDocumentName(folderId);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, createBoardYDocSnapshot({
      folderId,
      boardItems: [{
        id: "session:s1",
        folderId,
        itemType: "session",
        itemId: "s1",
        x: 0,
        y: 0,
        metadata: {},
      }],
      markdownDocuments: [],
    }));
    const boardItems = doc.getMap("boardItems");
    boardItems.set("session:s1", {
      item_type: "session",
      item_id: "s1",
      x: 280,
      y: 160,
      metadata: {},
    });
    const update = Y.encodeStateAsUpdate(doc);
    const db = {
      appendBoardYjsUpdate: vi.fn().mockResolvedValue(undefined),
      storeBoardYjsSnapshot: vi.fn().mockResolvedValue(undefined),
      syncBoardYjsReplica: vi.fn().mockResolvedValue(undefined),
      invalidateBoardYjsCatalogCache: vi.fn(),
    } as unknown as SessionDB;

    const persistence = createBoardYjsPersistence(db);
    await persistence.updateLog.onChange?.({
      documentName,
      document: doc,
      update,
    } as never);

    expect(db.appendBoardYjsUpdate).toHaveBeenCalledWith(documentName, update);
    expect(db.storeBoardYjsSnapshot).toHaveBeenCalledWith(
      documentName,
      expect.any(Uint8Array),
    );
    expect(db.syncBoardYjsReplica).toHaveBeenCalledWith(
      folderId,
      expect.objectContaining({
        boardItems: [expect.objectContaining({ id: "session:s1", x: 280, y: 160 })],
      }),
    );
    expect(db.invalidateBoardYjsCatalogCache).toHaveBeenCalledWith(folderId);

    const storedSnapshot = vi.mocked(db.storeBoardYjsSnapshot).mock.calls[0][1];
    const storedDoc = new Y.Doc();
    Y.applyUpdate(storedDoc, storedSnapshot);
    expect(readBoardYDocReplica(folderId, storedDoc).boardItems[0]).toMatchObject({
      id: "session:s1",
      x: 280,
      y: 160,
    });
  });
});
