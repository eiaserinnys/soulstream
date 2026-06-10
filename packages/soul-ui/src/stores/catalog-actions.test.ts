import { describe, expect, it } from "vitest";

import type { CatalogState } from "../shared/types";
import { addBoardItemToCatalog } from "./catalog-actions";

describe("catalog-actions", () => {
  it("upserts existing board items by id without duplicating them", () => {
    const catalog: CatalogState = {
      folders: [],
      sessions: {},
      boardItems: [{
        id: "frame:launch",
        folderId: "root",
        itemType: "frame",
        itemId: "frame:launch",
        x: 0,
        y: 0,
        metadata: {
          title: "Launch",
          collapsed: false,
          childItemIds: [],
        },
      }],
    };

    const updated = addBoardItemToCatalog(catalog, {
      id: "frame:launch",
      folderId: "root",
      itemType: "frame",
      itemId: "frame:launch",
      x: 0,
      y: 0,
      metadata: {
        title: "Launch",
        collapsed: true,
        childItemIds: ["session:a"],
      },
    });

    expect(updated.boardItems).toHaveLength(1);
    expect(updated.boardItems?.[0]?.metadata).toMatchObject({
      collapsed: true,
      childItemIds: ["session:a"],
    });
  });
});
