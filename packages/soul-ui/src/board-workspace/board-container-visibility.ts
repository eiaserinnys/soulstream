import type { BoardContainerRef, CatalogBoardItem } from "../shared/types";

export function boardItemBelongsToContainer(
  item: CatalogBoardItem,
  container: BoardContainerRef,
): boolean {
  const itemContainerKind = item.containerKind ?? "folder";
  const itemContainerId = item.containerId ?? item.folderId;
  return itemContainerKind === container.kind && itemContainerId === container.id;
}

function isPrimarySessionBoardItem(item: CatalogBoardItem): boolean {
  return item.itemType === "session" && (item.membershipKind ?? "primary") === "primary";
}

export function sessionIdsOwnedByOtherBoardContainer(
  boardItems: readonly CatalogBoardItem[] | undefined,
  currentContainer: BoardContainerRef | null | undefined,
  folderScopeId: string | null | undefined,
): Set<string> {
  if (!boardItems || !currentContainer || !folderScopeId) return new Set();
  const sessionIds = new Set<string>();
  for (const item of boardItems) {
    if (item.folderId !== folderScopeId || !isPrimarySessionBoardItem(item)) continue;
    if (!boardItemBelongsToContainer(item, currentContainer)) {
      sessionIds.add(item.itemId);
    }
  }
  return sessionIds;
}
