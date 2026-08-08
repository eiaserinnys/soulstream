import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { createBoardYjsPersistence } from "../src/board-yjs/board_yjs_persistence.js";
import {
  createBoardYDocSnapshot,
  getBoardYjsDocumentName,
  readBoardYDocReplica,
} from "../src/board-yjs/board_yjs_model.js";
import type { BoardYjsPersistenceRepository } from "../src/board-yjs/board_yjs_persistence.js";

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
      loadBoardYjsSnapshot: vi.fn().mockResolvedValue({ snapshot, revision: 1 }),
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
      storeBoardYjsSnapshot: vi.fn().mockResolvedValue(null),
      backfillTaskBoardItemsIntoSnapshot: vi.fn().mockResolvedValue({ snapshot, revision: 1 }),
    } as unknown as BoardYjsPersistenceRepository;

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
    expect(db.backfillTaskBoardItemsIntoSnapshot).toHaveBeenCalledWith(
      documentName,
      { folderId, containerKind: "folder", containerId: folderId },
      { snapshot, revision: 1 },
    );
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
      loadBoardYjsSnapshot: vi.fn().mockResolvedValue({ snapshot, revision: 3 }),
      resolveBoardYjsContainerScope: vi.fn().mockResolvedValue({
        folderId,
        containerKind: "folder",
        containerId: folderId,
      }),
      backfillTaskBoardItemsIntoSnapshot: vi.fn().mockResolvedValue({
        snapshot: repaired,
        revision: 4,
      }),
    } as unknown as BoardYjsPersistenceRepository;

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

  it("fetch는 task 컨테이너 seed와 projection을 하나의 CAS로 생성한다", async () => {
    const documentName = "board:task:rb-1";
    const scope = {
      folderId: "folder-1",
      containerKind: "task" as const,
      containerId: "rb-1",
    };
    const db = {
      loadBoardYjsSnapshot: vi.fn().mockResolvedValue(null),
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
      storeBoardYjsSnapshot: vi.fn(async (
        _documentName: string,
        encoded: Uint8Array,
      ) => ({ snapshot: encoded, revision: 1 })),
    } as unknown as BoardYjsPersistenceRepository;

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
    expect(db.storeBoardYjsSnapshot).toHaveBeenCalledWith(
      documentName,
      expect.any(Uint8Array),
      null,
      {
        scope,
        replica: expect.objectContaining({
          boardItems: [expect.objectContaining({ id: "markdown:d1" })],
        }),
      },
    );
  });

  it("onChange writes the canonical snapshot, syncs replica, and invalidates catalog cache", async () => {
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
    const db = {
      resolveBoardYjsContainerScope: vi.fn().mockResolvedValue({
        folderId,
        containerKind: "folder",
        containerId: folderId,
      }),
      loadBoardYjsSnapshot: vi.fn().mockResolvedValue(null),
      storeBoardYjsSnapshot: vi.fn(async (
        _documentName: string,
        stored: Uint8Array,
      ) => ({ snapshot: stored, revision: 1 })),
      invalidateBoardYjsCatalogCache: vi.fn(),
    } as unknown as BoardYjsPersistenceRepository;

    const persistence = createBoardYjsPersistence(db);
    await persistence.snapshotSync.onChange?.({
      documentName,
      document: doc,
      update: Y.encodeStateAsUpdate(doc),
    } as never);

    expect(db.storeBoardYjsSnapshot).toHaveBeenCalledWith(
      documentName,
      expect.any(Uint8Array),
      null,
      {
        scope: { folderId, containerKind: "folder", containerId: folderId },
        replica: expect.objectContaining({
          boardItems: [expect.objectContaining({ id: "session:s1", x: 280, y: 160 })],
        }),
      },
    );
    expect(db.invalidateBoardYjsCatalogCache).toHaveBeenCalledWith({
      folderId,
      containerKind: "folder",
      containerId: folderId,
    });

    const storedSnapshot = vi.mocked(db.storeBoardYjsSnapshot).mock.calls[0]![1];
    const storedDoc = new Y.Doc();
    Y.applyUpdate(storedDoc, storedSnapshot);
    expect(readBoardYDocReplica(folderId, storedDoc).boardItems[0]).toMatchObject({
      id: "session:s1",
      x: 280,
      y: 160,
    });
  });
});
