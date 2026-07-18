import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  createBoardYDocSnapshot,
  getBoardYjsContainerDocumentName,
  getFormalBoardYjsDocumentName,
  normalizeBoardYjsDocumentName,
  parseBoardYjsDocumentName,
  readBoardYDocReplica,
} from "../src/board-yjs/board_yjs_model.js";

describe("orch board Yjs model", () => {
  it("keeps legacy folder names and canonical container names round-trippable", () => {
    const folder = { containerKind: "folder" as const, containerId: "folder-1" };
    const task = { containerKind: "task" as const, containerId: "rb-1" };

    expect(getBoardYjsContainerDocumentName(folder)).toBe("board-folder:folder-1");
    expect(getFormalBoardYjsDocumentName(folder)).toBe("board:folder:folder-1");
    expect(normalizeBoardYjsDocumentName("board:folder:folder-1"))
      .toBe("board-folder:folder-1");
    expect(parseBoardYjsDocumentName("board-folder:folder-1")).toEqual(folder);
    expect(parseBoardYjsDocumentName("board:task:rb-1")).toEqual(task);
    expect(getBoardYjsContainerDocumentName(task)).toBe("board:task:rb-1");
  });

  it("derives the same ordered board_items replica from one Y.Doc state", () => {
    const scope = {
      folderId: "folder-1",
      containerKind: "task" as const,
      containerId: "rb-1",
    };
    const snapshot = createBoardYDocSnapshot({
      ...scope,
      boardItems: [
        {
          id: "session:s2",
          folderId: "folder-1",
          containerKind: "task",
          containerId: "rb-1",
          membershipKind: "primary",
          sourceTaskItemId: "item-2",
          itemType: "session",
          itemId: "s2",
          x: 300,
          y: 200,
          metadata: { title: "Second" },
        },
        {
          id: "markdown:d1",
          folderId: "folder-1",
          containerKind: "task",
          containerId: "rb-1",
          membershipKind: "primary",
          sourceTaskItemId: null,
          itemType: "markdown",
          itemId: "d1",
          x: 100,
          y: 100,
          metadata: { title: "Note" },
        },
      ],
      markdownDocuments: [{ id: "d1", title: "Note", body: "Body", version: 3 }],
    });
    const doc = new Y.Doc();
    Y.applyUpdate(doc, snapshot);

    expect(readBoardYDocReplica(scope, doc)).toEqual({
      boardItems: [
        expect.objectContaining({
          id: "markdown:d1",
          containerKind: "task",
          containerId: "rb-1",
          x: 100,
          y: 100,
          metadata: { title: "Note", version: 3 },
        }),
        expect.objectContaining({
          id: "session:s2",
          sourceTaskItemId: "item-2",
          x: 300,
          y: 200,
        }),
      ],
      markdownDocuments: [{ id: "d1", title: "Note", body: "Body", version: 3 }],
    });
  });
});
