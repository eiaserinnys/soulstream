import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { BOARD_ITEMS_MAP } from "../src/board-yjs/board_yjs_document.js";
import {
  getCanonicalRunbookDocumentName,
  inspectBoardYjsRunbookResidue,
  migrateBoardYjsRunbookResidue,
} from "../src/board-yjs/board_yjs_runbook_residue.js";

describe("board Y.Doc runbook residue migration", () => {
  it("renames only structural legacy fields and preserves opaque runbook IDs", () => {
    const doc = new Y.Doc();
    const boardItems = doc.getMap<Record<string, unknown>>(BOARD_ITEMS_MAP);
    boardItems.set("runbook:opaque-id", {
      item_type: "runbook",
      item_id: "runbook:user-owned-id",
      source_runbook_item_id: "item-a",
      metadata: {
        sourceRunbookItemId: "item-b",
        note: "runbook: user text is not a schema field",
      },
      x: 1,
      y: 2,
    });

    const result = migrateBoardYjsRunbookResidue("board:runbook:task-a", doc);

    expect(result.before).toEqual({
      legacyDocumentName: 1,
      legacyItemTypes: 1,
      legacySourceKeys: 2,
      opaqueBoardItemIds: ["runbook:opaque-id"],
    });
    expect(result.after).toEqual({
      legacyDocumentName: 0,
      legacyItemTypes: 0,
      legacySourceKeys: 0,
      opaqueBoardItemIds: ["runbook:opaque-id"],
    });
    expect(boardItems.get("runbook:opaque-id")).toEqual({
      item_type: "task",
      item_id: "runbook:user-owned-id",
      source_task_item_id: "item-a",
      metadata: {
        sourceTaskItemId: "item-b",
        note: "runbook: user text is not a schema field",
      },
      x: 1,
      y: 2,
    });
    expect(result.changedBoardItems).toBe(1);
  });

  it("keeps an existing canonical source key when both spellings are present", () => {
    const doc = new Y.Doc();
    const boardItems = doc.getMap<Record<string, unknown>>(BOARD_ITEMS_MAP);
    boardItems.set("session:a", {
      item_type: "session",
      source_task_item_id: "canonical",
      source_runbook_item_id: "legacy",
    });

    migrateBoardYjsRunbookResidue("board-folder:folder-a", doc);

    expect(boardItems.get("session:a")).toEqual({
      item_type: "session",
      source_task_item_id: "canonical",
    });
    expect(inspectBoardYjsRunbookResidue("board-folder:folder-a", doc)).toMatchObject({
      legacyDocumentName: 0,
      legacyItemTypes: 0,
      legacySourceKeys: 0,
    });
  });

  it("maps only the legacy document kind segment", () => {
    expect(getCanonicalRunbookDocumentName("board:runbook:runbook:opaque"))
      .toBe("board:task:runbook:opaque");
    expect(getCanonicalRunbookDocumentName("board-folder:runbook:opaque"))
      .toBe("board-folder:runbook:opaque");
  });
});
