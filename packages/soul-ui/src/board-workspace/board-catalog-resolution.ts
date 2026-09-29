import type { BoardContainerRef, CatalogBoardItem, CatalogState } from "../shared/types";
import { boardItemBelongsToContainer } from "./board-container-visibility";

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
  if (!catalog || !yjsBoardItemsForSelectedFolder || isYjsLoading || !hasYjsSynced) return catalog;
  const resolvedYjsBoardItems = yjsBoardItemsForSelectedFolder.map((item) => {
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
  const otherFolderBoardItems = (catalog.boardItems ?? []).filter((item) =>
    boardContainer ? !boardItemBelongsToContainer(item, boardContainer) : item.folderId !== selectedFolderId
  );
  return {
    ...catalog,
    boardItems: [...otherFolderBoardItems, ...resolvedYjsBoardItems],
  };
}
