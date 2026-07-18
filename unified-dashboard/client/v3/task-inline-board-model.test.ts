import { describe, expect, it } from "vitest";
import type { CatalogBoardItem } from "@seosoyoung/soul-ui";

import {
  boardMarkdownDocuments,
  findTaskMarkdownPlacement,
  patchBoardMarkdownTitle,
} from "./task-inline-board-model";

describe("task inline board model", () => {
  it("exposes only board markdown as session document context", () => {
    expect(boardMarkdownDocuments([
      item("markdown", "doc-1", { title: "결정문", version: 2 }),
      item("custom_view", "view-1", { title: "진행률" }),
      item("asset", "asset-1", { title: "첨부" }),
    ])).toEqual([{ pageId: "doc-1", title: "결정문" }]);
  });

  it("patches one markdown title and version without replacing other items", () => {
    const original = [
      item("markdown", "doc-1", { title: "전", version: 2 }),
      item("markdown", "doc-2", { title: "유지", version: 5 }),
    ];

    const next = patchBoardMarkdownTitle(original, "doc-1", "후", 3);

    expect(next[0]).toMatchObject({ metadata: { title: "후", version: 3 } });
    expect(next[1]).toBe(original[1]);
  });

  it("places new markdown outside the fixed task card and existing tiles", () => {
    const placement = findTaskMarkdownPlacement([
      { ...item("markdown", "doc-1", { title: "문서" }), x: 400, y: 0 },
    ]);

    expect(overlaps(
      { ...placement, width: 280, height: 160 },
      { x: 0, y: 0, width: 360, height: 520 },
    )).toBe(false);
    expect(overlaps(
      { ...placement, width: 280, height: 160 },
      { x: 400, y: 0, width: 280, height: 160 },
    )).toBe(false);
  });
});

function item(
  itemType: CatalogBoardItem["itemType"],
  itemId: string,
  metadata: Record<string, unknown>,
): CatalogBoardItem {
  return {
    id: `${itemType}:${itemId}`,
    folderId: "folder-a",
    containerKind: "task",
    containerId: "rb-a",
    itemType,
    itemId,
    x: 0,
    y: 0,
    metadata,
  };
}

function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width
    && a.x + a.width > b.x
    && a.y < b.y + b.height
    && a.y + a.height > b.y;
}
