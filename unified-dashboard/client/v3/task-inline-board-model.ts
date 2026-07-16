import {
  BOARD_RUNBOOK_FIXED_CARD_RECT,
  BOARD_TILE_HEIGHT,
  BOARD_TILE_WIDTH,
  findEmptyPlacement,
  type CatalogBoardItem,
} from "@seosoyoung/soul-ui";

export interface TaskBoardMarkdownDocument {
  pageId: string;
  title: string;
}

export function boardMarkdownDocuments(
  items: readonly CatalogBoardItem[],
): TaskBoardMarkdownDocument[] {
  return items.flatMap((item) => {
    if (item.itemType !== "markdown") return [];
    return [{
      pageId: item.itemId,
      title: metadataText(item, "title") || "제목 없는 문서",
    }];
  });
}

export function patchBoardMarkdownTitle(
  items: readonly CatalogBoardItem[],
  documentId: string,
  title: string,
  version?: number,
): CatalogBoardItem[] {
  return items.map((item) => item.itemType === "markdown" && item.itemId === documentId
    ? {
        ...item,
        metadata: {
          ...(item.metadata ?? {}),
          title,
          ...(version === undefined ? {} : { version }),
        },
      }
    : item);
}

export function findTaskMarkdownPlacement(
  items: readonly CatalogBoardItem[],
): { x: number; y: number } {
  return findEmptyPlacement({
    existingItems: [BOARD_RUNBOOK_FIXED_CARD_RECT, ...items],
    preferredPoint: {
      x: BOARD_RUNBOOK_FIXED_CARD_RECT.width + 40,
      y: BOARD_RUNBOOK_FIXED_CARD_RECT.y,
    },
    size: { width: BOARD_TILE_WIDTH, height: BOARD_TILE_HEIGHT },
  })[0] ?? {
    x: BOARD_RUNBOOK_FIXED_CARD_RECT.width + 40,
    y: BOARD_RUNBOOK_FIXED_CARD_RECT.y,
  };
}

export function metadataText(item: CatalogBoardItem, key: string): string {
  const value = item.metadata?.[key];
  return typeof value === "string" ? value.trim() : "";
}

export function metadataVersion(item: CatalogBoardItem): number | null {
  const value = item.metadata?.version;
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}
