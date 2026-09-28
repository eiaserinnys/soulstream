import { describe, expect, it, vi } from "vitest";

import { CatalogBoardItemService } from "../../src/catalog/catalog_board_item_service.js";

describe("CatalogBoardItemService.createMarkdownDocument", () => {
  it("uses the container-scoped read and selects the first free grid position", async () => {
    const folderId = "root";
    const container = { containerKind: "task" as const, containerId: "task-1" };
    const scopedItems = [
      {
        id: "markdown:occupied-1",
        folderId,
        containerKind: "task" as const,
        containerId: "task-1",
        itemType: "markdown" as const,
        itemId: "occupied-1",
        x: 0,
        y: 0,
        metadata: {},
      },
      {
        id: "markdown:occupied-2",
        folderId,
        containerKind: "task" as const,
        containerId: "task-1",
        itemType: "markdown" as const,
        itemId: "occupied-2",
        x: 280,
        y: 0,
        metadata: {},
      },
    ];
    const getBoardItemsByContainer = vi.fn(async () => scopedItems);
    const getBoardItems = vi.fn(async () => scopedItems);
    const createMarkdownDocument = vi.fn(async (input: {
      documentId: string;
      folderId: string;
      title: string;
      body: string;
      x: number;
      y: number;
    }) => ({
      document: {
        id: input.documentId,
        title: input.title,
        body: input.body,
        version: 1,
      },
      boardItem: {
        id: `markdown:${input.documentId}`,
        folderId: input.folderId,
        containerKind: container.containerKind,
        containerId: container.containerId,
        itemType: "markdown" as const,
        itemId: input.documentId,
        x: input.x,
        y: input.y,
        metadata: {},
      },
    }));
    const service = new CatalogBoardItemService(
      { getBoardItemsByContainer, getBoardItems } as never,
      { createMarkdownDocument } as never,
      vi.fn(async () => undefined),
    );

    const result = await service.createMarkdownDocument({
      folderId,
      container,
      title: "Note",
      body: "Body",
    });

    expect(getBoardItemsByContainer).toHaveBeenCalledWith(folderId, container);
    expect(getBoardItems).not.toHaveBeenCalled();
    expect(createMarkdownDocument).toHaveBeenCalledWith(expect.objectContaining({
      folderId,
      container,
      title: "Note",
      body: "Body",
      x: 560,
      y: 0,
    }));
    expect(result.boardItem).toMatchObject({ x: 560, y: 0 });
  });
});
