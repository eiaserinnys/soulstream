import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { BOARD_ITEMS_MAP } from "../src/board-yjs/board_yjs_document.js";
import { requireBoardItemCatalogProjection } from
  "../src/board-yjs/board_yjs_projection_verification.js";

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
});
