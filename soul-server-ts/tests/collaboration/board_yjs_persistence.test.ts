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
  it("fetch는 기존 snapshot이 있으면 DB seed를 읽지 않고 Yjs 정본을 그대로 반환", async () => {
    const folderId = "folder-1";
    const documentName = getBoardYjsDocumentName(folderId);
    const snapshot = createBoardYDocSnapshot({
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
    });
    const db = {
      getBoardYjsSnapshot: vi.fn().mockResolvedValue(snapshot),
      resolveBoardYjsContainerScope: vi.fn().mockResolvedValue({
        folderId,
        containerKind: "folder",
        containerId: folderId,
      }),
      loadBoardYjsSeed: vi.fn().mockResolvedValue({
        boardItems: [{
          id: "markdown:d1",
          folderId,
          itemType: "markdown",
          itemId: "d1",
          x: 280,
          y: 160,
          metadata: { title: "Recovered" },
        }],
        markdownDocuments: [{ id: "d1", title: "Recovered", body: "restored body", version: 1 }],
      }),
      storeBoardYjsSnapshot: vi.fn().mockResolvedValue(undefined),
      markBoardYjsDocumentSynced: vi.fn().mockResolvedValue(undefined),
      syncBoardYjsReplica: vi.fn().mockResolvedValue(undefined),
      backfillTaskBoardItemsIntoBoardYjsSnapshot: vi.fn().mockResolvedValue(snapshot),
    } as unknown as SessionDB;

    const persistence = createBoardYjsPersistence(db);
    const fetched = await persistence.database.configuration.fetch?.({
      documentName,
    } as never);

    expect(fetched).toBe(snapshot);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, fetched as Uint8Array);
    expect(readBoardYDocReplica(folderId, doc).boardItems.map((item) => item.id)).toEqual([
      "session:s1",
    ]);
    expect(db.loadBoardYjsSeed).not.toHaveBeenCalled();
    expect(db.storeBoardYjsSnapshot).not.toHaveBeenCalled();
    expect(db.syncBoardYjsReplica).not.toHaveBeenCalled();
    expect(db.backfillTaskBoardItemsIntoBoardYjsSnapshot).toHaveBeenCalledWith(
      documentName,
      { folderId, containerKind: "folder", containerId: folderId },
      snapshot,
    );
    expect(db.markBoardYjsDocumentSynced).not.toHaveBeenCalled();
  });

  it("fetch는 기존 snapshot의 DB-only task tile을 보강한 snapshot을 반환", async () => {
    const folderId = "folder-1";
    const documentName = getBoardYjsDocumentName(folderId);
    const snapshot = createBoardYDocSnapshot({
      folderId,
      boardItems: [],
      markdownDocuments: [],
    });
    const repaired = createBoardYDocSnapshot({
      folderId,
      boardItems: [{
        id: "task:rb-1",
        folderId,
        itemType: "task",
        itemId: "rb-1",
        x: 0,
        y: 0,
        metadata: { title: "Task" },
      }],
      markdownDocuments: [],
    });
    const db = {
      getBoardYjsSnapshot: vi.fn().mockResolvedValue(snapshot),
      resolveBoardYjsContainerScope: vi.fn().mockResolvedValue({
        folderId,
        containerKind: "folder",
        containerId: folderId,
      }),
      backfillTaskBoardItemsIntoBoardYjsSnapshot: vi.fn().mockResolvedValue(repaired),
    } as unknown as SessionDB;

    const persistence = createBoardYjsPersistence(db);
    const fetched = await persistence.database.configuration.fetch?.({
      documentName,
    } as never);

    const doc = new Y.Doc();
    Y.applyUpdate(doc, fetched as Uint8Array);
    expect(readBoardYDocReplica(folderId, doc).boardItems).toEqual([
      expect.objectContaining({ id: "task:rb-1", itemType: "task" }),
    ]);
  });

  it("fetch는 task 컨테이너 문서 seed를 해당 컨테이너 항목으로 생성하고 synced marker를 남긴다", async () => {
    const documentName = "board:task:rb-1";
    const scope = {
      folderId: "folder-1",
      containerKind: "task" as const,
      containerId: "rb-1",
    };
    const db = {
      getBoardYjsSnapshot: vi.fn().mockResolvedValue(null),
      resolveBoardYjsContainerScope: vi.fn().mockResolvedValue(scope),
      loadBoardYjsSeed: vi.fn().mockResolvedValue({
        boardItems: [{
          id: "markdown:d1",
          folderId: "folder-1",
          containerKind: "task",
          containerId: "rb-1",
          itemType: "markdown",
          itemId: "d1",
          x: 0,
          y: 0,
          metadata: { title: "Task note" },
        }],
        markdownDocuments: [{ id: "d1", title: "Task note", body: "body", version: 1 }],
      }),
      storeBoardYjsSnapshot: vi.fn().mockResolvedValue(undefined),
      markBoardYjsDocumentSynced: vi.fn().mockResolvedValue(undefined),
    } as unknown as SessionDB;

    const persistence = createBoardYjsPersistence(db);
    const fetched = await persistence.database.configuration.fetch?.({
      documentName,
    } as never);

    const doc = new Y.Doc();
    Y.applyUpdate(doc, fetched as Uint8Array);
    expect(readBoardYDocReplica(scope, doc).boardItems).toEqual([
      expect.objectContaining({
        id: "markdown:d1",
        containerKind: "task",
        containerId: "rb-1",
      }),
    ]);
    expect(db.loadBoardYjsSeed).toHaveBeenCalledWith(scope);
    expect(db.storeBoardYjsSnapshot).toHaveBeenCalledWith(documentName, expect.any(Uint8Array));
    expect(db.markBoardYjsDocumentSynced).toHaveBeenCalledWith(documentName);
  });

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
      resolveBoardYjsContainerScope: vi.fn().mockResolvedValue({
        folderId,
        containerKind: "folder",
        containerId: folderId,
      }),
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
      { folderId, containerKind: "folder", containerId: folderId },
      expect.objectContaining({
        boardItems: [expect.objectContaining({ id: "session:s1", x: 280, y: 160 })],
      }),
      documentName,
    );
    expect(db.invalidateBoardYjsCatalogCache).toHaveBeenCalledWith({
      folderId,
      containerKind: "folder",
      containerId: folderId,
    });

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
