import { describe, expect, it, vi } from "vitest";

import { CatalogBoardItemService } from "../../src/catalog/catalog_board_item_service.js";

describe("CatalogBoardItemService.createMarkdownDocument", () => {
  it("delegates document creation without reading folder grid positions", async () => {
    const getBoardItemsByFolder = vi.fn();
    const getBoardItems = vi.fn();
    const created = {
      document: { id: "doc-1", folderId: "root", title: "Note", body: "Body", version: 1 },
      boardItem: { id: "markdown:doc-1", folderId: "root", itemType: "markdown" as const,
        itemId: "doc-1", x: 0, y: 0, metadata: {} },
    };
    const createMarkdownDocument = vi.fn(async () => created);
    const service = new CatalogBoardItemService(
      { getBoardItemsByFolder, getBoardItems } as never,
      { createMarkdownDocument } as never,
    );
    const result = await service.createMarkdownDocument({
      documentId: "doc-1", folderId: "root", title: "Note", body: "Body",
    });
    expect(getBoardItemsByFolder).not.toHaveBeenCalled();
    expect(getBoardItems).not.toHaveBeenCalled();
    expect(createMarkdownDocument).toHaveBeenCalledWith({
      documentId: "doc-1", folderId: "root", title: "Note", body: "Body", x: undefined, y: undefined,
    });
    expect(result).toBe(created);
  });
});
