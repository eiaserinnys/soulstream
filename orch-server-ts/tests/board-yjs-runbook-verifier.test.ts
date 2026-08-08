import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { BOARD_ITEMS_MAP } from "../src/board-yjs/board_yjs_document.js";
import {
  assertNoBoardItemMembershipMismatches,
  assertBoardItemProjectionParity,
  assertNoCrossDocumentBoardItemDuplicates,
  inspectCrossDocumentBoardItemDuplicates,
  inspectBoardItemMembershipDifference,
  requireBoardItemCatalogProjection,
} from
  "../src/board-yjs/board_yjs_projection_verification.js";
import {
  findMissingSourceTaskItemReferences,
  normalizeMissingSourceTaskItemReferences,
} from
  "../src/board-yjs/board_yjs_replica_normalization.js";
import type { CatalogBoardItemRow } from "../src/board-yjs/board_yjs_types.js";

describe("board Y.Doc runbook verifier catalog parity", () => {
  it("allows a missing catalog projection for an empty recomposed Y.Doc", () => {
    const doc = new Y.Doc();

    expect(requireBoardItemCatalogProjection({
      label: "board:task:empty",
      ydocItemCount: doc.getMap(BOARD_ITEMS_MAP).size,
      projection: null,
    })).toBeNull();
  });

  it("rejects a missing catalog projection for a non-empty recomposed Y.Doc", () => {
    const doc = new Y.Doc();
    doc.getMap(BOARD_ITEMS_MAP).set("session:a", { item_type: "session" });

    expect(() => requireBoardItemCatalogProjection({
      label: "board:task:non-empty",
      ydocItemCount: doc.getMap(BOARD_ITEMS_MAP).size,
      projection: null,
    })).toThrow(
      "missing catalog projection for board Y.Doc: board:task:non-empty",
    );
  });

  it("accepts a projection normalized after its source task item was deleted", () => {
    const ydocItem: CatalogBoardItemRow = {
      id: "session:deleted-source",
      folderId: "folder-1",
      containerKind: "task",
      containerId: "task-1",
      membershipKind: "primary",
      sourceTaskItemId: "deleted-task-item",
      itemType: "session",
      itemId: "deleted-source",
      x: 10,
      y: 20,
      metadata: {},
    };

    const normalizedYdocReplica = normalizeMissingSourceTaskItemReferences(
      { boardItems: [ydocItem], markdownDocuments: [] },
      new Set(),
    );
    expect(() => assertBoardItemProjectionParity({
      label: "board:task:task-1",
      ydocItems: normalizedYdocReplica.boardItems,
      projectionItems: [{ ...ydocItem, sourceTaskItemId: null }],
    })).not.toThrow();
  });

  it("reports both directions of Y.Doc and board_items membership drift", () => {
    const ydocOnly = boardItem("session:ydoc-only");
    const boardItemsOnly = boardItem("session:board-items-only");

    expect(inspectBoardItemMembershipDifference({
      ydocItems: [ydocOnly],
      projectionItems: [boardItemsOnly],
    })).toEqual({
      missingFromProjection: ["session:ydoc-only"],
      missingFromYdoc: ["session:board-items-only"],
    });
  });

  it("keeps board_items field drift outside the membership comparison", () => {
    const ydocItem = boardItem("session:same-membership");
    const relationalItem = { ...ydocItem, x: 999, metadata: { stale: true } };

    expect(inspectBoardItemMembershipDifference({
      ydocItems: [ydocItem],
      projectionItems: [relationalItem],
    })).toEqual({
      missingFromProjection: [],
      missingFromYdoc: [],
    });
  });

  it("blocks the same board item ID appearing in different Y.Doc documents", () => {
    const documents = [
      {
        documentName: "board-folder:folder-a",
        boardItemIds: ["session:folder-only", "markdown:shared"],
      },
      {
        documentName: "board:task:task-a",
        boardItemIds: ["markdown:shared", "session:task-only"],
      },
    ];

    expect(inspectCrossDocumentBoardItemDuplicates(documents)).toEqual([{
      boardItemId: "markdown:shared",
      documentNames: ["board-folder:folder-a", "board:task:task-a"],
    }]);
    expect(() => assertNoCrossDocumentBoardItemDuplicates(documents)).toThrow(
      "board item IDs occur in multiple Y.Doc documents: 1 IDs across 2 documents",
    );
  });

  it("blocks folder board_items membership drift", () => {
    expect(() => assertNoBoardItemMembershipMismatches([{
      container: "folder:folder-a",
      documentName: "board-folder:folder-a",
      ydocOnly: ["session:ydoc-only"],
      boardItemsOnly: [],
    }])).toThrow(
      "board_items projection mismatch: 1 rows across 1 containers",
    );
  });

  it("normalizes stale projection references without hiding the warning", () => {
    const item = {
      ...boardItem("session:stale-source"),
      sourceTaskItemId: "deleted-task-item",
    };
    const existingSourceTaskItemIds = new Set<string>();
    const normalizedYdoc = normalizeMissingSourceTaskItemReferences(
      { boardItems: [item], markdownDocuments: [] },
      existingSourceTaskItemIds,
    );
    const normalizedProjection = normalizeMissingSourceTaskItemReferences(
      { boardItems: [item], markdownDocuments: [] },
      existingSourceTaskItemIds,
    );

    expect(() => assertBoardItemProjectionParity({
      label: "board:task:task-1 board_items",
      ydocItems: normalizedYdoc.boardItems,
      projectionItems: normalizedProjection.boardItems,
    })).not.toThrow();
    expect(findMissingSourceTaskItemReferences(
      [item],
      existingSourceTaskItemIds,
    )).toEqual([{
      boardItemId: "session:stale-source",
      sourceTaskItemId: "deleted-task-item",
    }]);
  });
});

function boardItem(id: string): CatalogBoardItemRow {
  return {
    id,
    folderId: "folder-1",
    containerKind: "task",
    containerId: "task-1",
    membershipKind: "primary",
    sourceTaskItemId: null,
    itemType: "session",
    itemId: id.replace("session:", ""),
    x: 10,
    y: 20,
    metadata: {},
  };
}
