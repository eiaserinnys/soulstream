import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  applyBoardYjsPosition,
  createBoardYDocSnapshot,
  getFormalBoardYjsDocumentName,
  createMarkdownYjsDocument,
  deleteMarkdownYjsDocument,
  getBoardYjsDocumentName,
  getFolderIdFromBoardYjsDocumentName,
  normalizeBoardYjsDocumentName,
  parseBoardYjsDocumentName,
  readBoardYDocSnapshot,
  readBoardYDocReplica,
  upsertCustomViewYjsBoardItem,
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

  it("custom view board item은 HTML 본문 없이 metadata preview와 revision만 Y-doc에 저장한다", () => {
    const doc = new Y.Doc();

    const boardItem = upsertCustomViewYjsBoardItem(doc, {
      folderId: "folder-1",
      containerKind: "runbook",
      containerId: "rb-1",
    }, {
      boardItemId: "custom_view:cv-1",
      customViewId: "cv-1",
      title: "Progress panel",
      html: "<section><h1>Progress</h1><p>42%</p></section>",
      revision: 2,
      x: 120,
      y: 240,
    });

    expect(boardItem).toMatchObject({
      id: "custom_view:cv-1",
      folderId: "folder-1",
      containerKind: "runbook",
      containerId: "rb-1",
      membershipKind: "primary",
      sourceRunbookItemId: null,
      itemType: "custom_view",
      itemId: "cv-1",
      x: 120,
      y: 240,
      metadata: {
        title: "Progress panel",
        preview: "Progress 42%",
        revision: 2,
      },
    });
    expect(JSON.stringify(readBoardYDocReplica({
      folderId: "folder-1",
      containerKind: "runbook",
      containerId: "rb-1",
    }, doc))).not.toContain("<section>");
  });

  it("runbook session membership과 source runbook item id를 Y-doc snapshot으로 round-trip", () => {
    const snapshot = createBoardYDocSnapshot({
      folderId: "folder-1",
      containerKind: "runbook",
      containerId: "rb-1",
      boardItems: [{
        id: "session:s1",
        folderId: "folder-1",
        containerKind: "runbook",
        containerId: "rb-1",
        itemType: "session",
        itemId: "s1",
        membershipKind: "primary",
        sourceRunbookItemId: "runbook-item-1",
        x: 280,
        y: 160,
        metadata: {},
      }],
      markdownDocuments: [],
    });
    const doc = new Y.Doc();
    Y.applyUpdate(doc, snapshot);

    const replica = readBoardYDocReplica({
      folderId: "folder-1",
      containerKind: "runbook",
      containerId: "rb-1",
    }, doc);

    expect(replica.boardItems).toEqual([
      expect.objectContaining({
        id: "session:s1",
        folderId: "folder-1",
        containerKind: "runbook",
        containerId: "rb-1",
        membershipKind: "primary",
        sourceRunbookItemId: "runbook-item-1",
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

  it("markdown create helper는 runbook 컨테이너 board item을 생성한다", () => {
    const doc = new Y.Doc();

    const created = createMarkdownYjsDocument(doc, {
      folderId: "folder-1",
      containerKind: "runbook",
      containerId: "rb-1",
    }, {
      documentId: "doc-1",
      title: "Runbook note",
      body: "body",
      x: 40,
      y: 80,
    });

    expect(created.boardItem).toMatchObject({
      id: "markdown:doc-1",
      folderId: "folder-1",
      containerKind: "runbook",
      containerId: "rb-1",
      membershipKind: "primary",
      sourceRunbookItemId: null,
    });
    expect(readBoardYDocReplica({
      folderId: "folder-1",
      containerKind: "runbook",
      containerId: "rb-1",
    }, doc).boardItems).toEqual([
      expect.objectContaining({
        id: "markdown:doc-1",
        containerKind: "runbook",
        containerId: "rb-1",
      }),
    ]);
  });

  it("document name은 folder id와 양방향 매핑", () => {
    const name = getBoardYjsDocumentName("folder-1");
    expect(name).toBe("board-folder:folder-1");
    expect(getFolderIdFromBoardYjsDocumentName(name)).toBe("folder-1");
    expect(getFormalBoardYjsDocumentName({
      containerKind: "folder",
      containerId: "folder-1",
    })).toBe("board:folder:folder-1");
    expect(normalizeBoardYjsDocumentName("board:folder:folder-1")).toBe(name);
    expect(parseBoardYjsDocumentName("board:runbook:rb-1")).toEqual({
      containerKind: "runbook",
      containerId: "rb-1",
    });
    expect(getFolderIdFromBoardYjsDocumentName("/yjs/folder-1")).toBeNull();
  });

  it("runbook 컨테이너 snapshot은 같은 folderId 안에서도 runbook membership만 seed한다", () => {
    const snapshot = createBoardYDocSnapshot({
      folderId: "folder-1",
      containerKind: "runbook",
      containerId: "rb-1",
      boardItems: [
        {
          id: "runbook-child",
          folderId: "folder-1",
          containerKind: "runbook",
          containerId: "rb-1",
          itemType: "markdown",
          itemId: "doc-1",
          x: 0,
          y: 0,
          metadata: { title: "Child" },
        },
        {
          id: "folder-tile",
          folderId: "folder-1",
          containerKind: "folder",
          containerId: "folder-1",
          itemType: "runbook",
          itemId: "rb-1",
          x: 100,
          y: 0,
          metadata: { title: "Parent" },
        },
      ],
      markdownDocuments: [{ id: "doc-1", title: "Child", body: "body", version: 1 }],
    });
    const doc = new Y.Doc();
    Y.applyUpdate(doc, snapshot);

    const replica = readBoardYDocReplica({
      folderId: "folder-1",
      containerKind: "runbook",
      containerId: "rb-1",
    }, doc);

    expect(replica.boardItems).toEqual([
      expect.objectContaining({
        id: "runbook-child",
        folderId: "folder-1",
        containerKind: "runbook",
        containerId: "rb-1",
      }),
    ]);
  });
});
