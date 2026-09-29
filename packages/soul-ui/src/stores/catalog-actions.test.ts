import { describe, expect, it } from "vitest";
import type { CatalogState } from "../shared/types";
import { addBoardItemToCatalog, setBoardItemsForContainerInCatalog } from "./catalog-actions";

const catalog: CatalogState = {
  folders: [], sessions: {}, boardItems: [
    { id: "session:a", folderId: "root", itemType: "session", itemId: "a", x: 0, y: 0 },
    { id: "session:b", folderId: "other", itemType: "session", itemId: "b", x: 10, y: 10 },
  ],
};

describe("catalog board actions", () => {
  it("upserts a board item by id", () => {
    const updated = addBoardItemToCatalog(catalog, {
      id: "session:a", folderId: "root", itemType: "session", itemId: "a", x: 20, y: 30,
    });
    expect(updated.boardItems).toHaveLength(2);
    expect(updated.boardItems?.find((item) => item.id === "session:a")).toMatchObject({ x: 20, y: 30 });
  });

  it("replaces only one folder board while retaining other folders", () => {
    const updated = setBoardItemsForContainerInCatalog(catalog, { kind: "folder", id: "root" }, [
      { id: "session:c", folderId: "root", itemType: "session", itemId: "c", x: 40, y: 50 },
    ]);
    expect(updated.boardItems?.map((item) => item.id)).toEqual(["session:b", "session:c"]);
  });
});
