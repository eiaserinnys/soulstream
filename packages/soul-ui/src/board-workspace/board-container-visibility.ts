import type { BoardContainerRef, CatalogBoardItem } from "../shared/types";

export function boardItemBelongsToContainer(
  item: CatalogBoardItem,
  container: BoardContainerRef,
): boolean {
  return item.folderId === container.id;
}

export function isPrimarySessionBoardItem(item: CatalogBoardItem): boolean {
  return item.itemType === "session" && (item.membershipKind ?? "primary") === "primary";
}
