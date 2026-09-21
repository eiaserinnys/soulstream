import type { BoardContainerRef, CatalogBoardItem, CatalogState } from "../shared/types";
import { boardItemBelongsToContainer } from "./board-container-visibility";
import { filterTaskBoardSpatialItems } from "./board-workspace-items";

export function folderBoardContainer(folderId: string | null): BoardContainerRef | null {
  return folderId ? { kind: "folder", id: folderId } : null;
}

export function resolveEffectiveBoardCatalog(params: {
  catalog: CatalogState | null;
  selectedFolderId: string | null;
  boardContainer?: BoardContainerRef | null;
  yjsBoardItemsForSelectedFolder: CatalogBoardItem[] | null;
  isYjsLoading: boolean;
  hasYjsSynced: boolean;
  assetSignedUrls: Record<string, string>;
}): CatalogState | null {
  const {
    catalog,
    selectedFolderId,
    boardContainer = folderBoardContainer(selectedFolderId),
    yjsBoardItemsForSelectedFolder,
    isYjsLoading,
    hasYjsSynced,
    assetSignedUrls,
  } = params;
  if (!catalog || !yjsBoardItemsForSelectedFolder || isYjsLoading || !hasYjsSynced) {
    if (!catalog?.boardItems || !boardContainer || boardContainer.kind === "folder") return catalog;
    return {
      ...catalog,
      boardItems: filterTaskBoardSpatialItems(
        catalog.boardItems.filter((item) => boardItemBelongsToContainer(item, boardContainer)),
      ),
    };
  }
  const resolvedYjsBoardItems = (
    boardContainer?.kind === "task"
      ? filterTaskBoardSpatialItems(yjsBoardItemsForSelectedFolder)
      : yjsBoardItemsForSelectedFolder
  ).map((item) => {
    if (item.itemType !== "asset") return item;
    const signedUrl = assetSignedUrls[item.id];
    if (!signedUrl) return item;
    return {
      ...item,
      metadata: {
        ...(item.metadata ?? {}),
        signedUrl,
      },
    };
  });
  if (boardContainer?.kind === "task") {
    return { ...catalog, boardItems: resolvedYjsBoardItems };
  }
  const otherFolderBoardItems = (catalog.boardItems ?? []).filter((item) =>
    boardContainer ? !boardItemBelongsToContainer(item, boardContainer) : item.folderId !== selectedFolderId
  );
  return {
    ...catalog,
    boardItems: [...otherFolderBoardItems, ...resolvedYjsBoardItems],
  };
}
