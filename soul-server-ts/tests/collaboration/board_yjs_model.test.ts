import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  applyBoardYjsPosition,
  createBoardYDocSnapshot,
  createMarkdownYjsDocument,
  deleteMarkdownYjsDocument,
  getBoardYjsDocumentName,
  getFolderIdFromBoardYjsDocumentName,
  readBoardYDocSnapshot,
  readBoardYDocReplica,
  updateMarkdownYjsDocument,
} from "../../src/collaboration/board_yjs_model.js";

describe("board_yjs_model", () => {
  it("board_items와 markdown body를 폴더 Y-doc snapshot으로 round-trip", () => {
    const snapshot = createBoardYDocSnapshot({
      folderId: "folder-1",
      boardItems: [
        {
          id: "session:s1",
          folderId: "folder-1",
          itemType: "session",
          itemId: "s1",
          x: 280,
          y: 160,
          metadata: {},
        },
        {
          id: "markdown:d1",
          folderId: "folder-1",
          itemType: "markdown",
          itemId: "d1",
          x: 0,
          y: 0,
          metadata: { title: "Note" },
        },
      ],
      markdownDocuments: [{ id: "d1", title: "Note", body: "hello", version: 1 }],
    });
    const doc = new Y.Doc();
    Y.applyUpdate(doc, snapshot);

    const replica = readBoardYDocReplica("folder-1", doc);

    expect(replica.boardItems.map((item) => item.id)).toEqual(["markdown:d1", "session:s1"]);
    expect(replica.markdownDocuments).toEqual([{ id: "d1", title: "Note", body: "hello", version: 1 }]);
  });

  it("runbook board item type을 폴더 Y-doc snapshot으로 round-trip", () => {
    const snapshot = createBoardYDocSnapshot({
      folderId: "folder-1",
      boardItems: [{
        id: "runbook:rb-1",
        folderId: "folder-1",
        itemType: "runbook",
        itemId: "rb-1",
        x: 60,
        y: 80,
        metadata: { title: "Launch runbook" },
      }],
      markdownDocuments: [],
    });
    const doc = new Y.Doc();
    Y.applyUpdate(doc, snapshot);

    const replica = readBoardYDocReplica("folder-1", doc);

    expect(replica.boardItems).toEqual([
      expect.objectContaining({
        id: "runbook:rb-1",
        itemType: "runbook",
        itemId: "rb-1",
        metadata: expect.objectContaining({ title: "Launch runbook" }),
      }),
    ]);
  });

  it("snapshot과 누적 update에서 catalog replica를 derive", () => {
    const snapshot = createBoardYDocSnapshot({
      folderId: "folder-1",
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
    });
    const doc = new Y.Doc();
    Y.applyUpdate(doc, snapshot);
    applyBoardYjsPosition(doc, "session:s1", { x: 280, y: 160 });
    const update = Y.encodeStateAsUpdate(doc);

    const decoded = readBoardYDocSnapshot({
      folderId: "folder-1",
      snapshot,
      updates: [update],
    });

    expect(decoded.replica.boardItems[0]).toMatchObject({
      id: "session:s1",
      x: 280,
      y: 160,
    });
    expect(decoded.snapshot.byteLength).toBeGreaterThan(0);
  });

  it("snapshot derive 결과는 Yjs 문서 정본만 반영한다", () => {
    const snapshot = createBoardYDocSnapshot({
      folderId: "folder-1",
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
    });

    const decoded = readBoardYDocSnapshot({
      folderId: "folder-1",
      snapshot,
    });

    expect(decoded).not.toHaveProperty("seedMerged");
    expect(decoded.replica.boardItems.map((item) => item.id)).toEqual(["session:s1"]);
    expect(decoded.replica.markdownDocuments).toEqual([]);
  });

  it("position update는 같은 Y-map entry만 갱신", () => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, createBoardYDocSnapshot({
      folderId: "folder-1",
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
    }));

    applyBoardYjsPosition(doc, "session:s1", { x: -80, y: 40 });

    expect(readBoardYDocReplica("folder-1", doc).boardItems[0]).toMatchObject({
      id: "session:s1",
      x: -80,
      y: 40,
    });
  });

  it("markdown create/update/delete helper는 board item과 markdown body를 함께 갱신", () => {
    const doc = new Y.Doc();

    const created = createMarkdownYjsDocument(doc, "folder-1", {
      documentId: "doc-1",
      title: "  Note  ",
      body: "hello\nworld",
      x: 80,
      y: 40,
    });

    expect(created.document).toEqual({ id: "doc-1", title: "Note", body: "hello\nworld", version: 1 });
    expect(readBoardYDocReplica("folder-1", doc)).toMatchObject({
      boardItems: [{
        id: "markdown:doc-1",
        folderId: "folder-1",
        itemType: "markdown",
        itemId: "doc-1",
        x: 80,
        y: 40,
        metadata: { title: "Note", preview: "hello world", version: 1 },
      }],
      markdownDocuments: [{ id: "doc-1", title: "Note", body: "hello\nworld", version: 1 }],
    });

    const updated = updateMarkdownYjsDocument(doc, "doc-1", {
      title: "Renamed",
      body: "updated body",
      expectedVersion: 1,
    });
    expect(updated).toEqual({ id: "doc-1", title: "Renamed", body: "updated body", version: 2 });
    expect(readBoardYDocReplica("folder-1", doc).markdownDocuments).toEqual([
      { id: "doc-1", title: "Renamed", body: "updated body", version: 2 },
    ]);

    expect(() => updateMarkdownYjsDocument(doc, "doc-1", {
      body: "stale body",
      expectedVersion: 1,
    })).toThrow(/version conflict/);
    expect(readBoardYDocReplica("folder-1", doc).markdownDocuments).toEqual([
      { id: "doc-1", title: "Renamed", body: "updated body", version: 2 },
    ]);

    deleteMarkdownYjsDocument(doc, "doc-1");
    expect(readBoardYDocReplica("folder-1", doc)).toEqual({
      boardItems: [],
      markdownDocuments: [],
    });
  });

  it("document name은 folder id와 양방향 매핑", () => {
    const name = getBoardYjsDocumentName("folder-1");
    expect(name).toBe("board-folder:folder-1");
    expect(getFolderIdFromBoardYjsDocumentName(name)).toBe("folder-1");
    expect(getFolderIdFromBoardYjsDocumentName("/yjs/folder-1")).toBeNull();
  });
});
