import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { BOARD_ITEMS_MAP } from "../src/board-yjs/board_yjs_document.js";
import {
  assertBoardItemProjectionParity,
  requireBoardItemCatalogProjection,
} from
  "../src/board-yjs/board_yjs_projection_verification.js";
import { normalizeMissingSourceTaskItemReferences } from
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
});
