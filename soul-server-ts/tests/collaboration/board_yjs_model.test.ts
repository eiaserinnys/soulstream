import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  applyBoardYjsPosition,
  createBoardYDocSnapshot,
  getBoardYjsDocumentName,
  getFolderIdFromBoardYjsDocumentName,
  readBoardYDocReplica,
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
      markdownDocuments: [{ id: "d1", title: "Note", body: "hello" }],
    });
    const doc = new Y.Doc();
    Y.applyUpdate(doc, snapshot);

    const replica = readBoardYDocReplica("folder-1", doc);

    expect(replica.boardItems.map((item) => item.id)).toEqual(["markdown:d1", "session:s1"]);
    expect(replica.markdownDocuments).toEqual([{ id: "d1", title: "Note", body: "hello" }]);
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

  it("document name은 folder id와 양방향 매핑", () => {
    const name = getBoardYjsDocumentName("folder-1");
    expect(name).toBe("board-folder:folder-1");
    expect(getFolderIdFromBoardYjsDocumentName(name)).toBe("folder-1");
    expect(getFolderIdFromBoardYjsDocumentName("/yjs/folder-1")).toBeNull();
  });
});
