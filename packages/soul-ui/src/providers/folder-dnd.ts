import { arrayMove } from "@dnd-kit/sortable";

import type { CatalogFolderReorderItem } from "../shared/catalog-types";

export interface FolderDragData {
  type: "folder";
  parentFolderId: string | null;
  siblingIds: string[];
  childIds: string[];
}

export interface FolderRootDropData {
  type: "folder-root";
  siblingIds: string[];
}

export interface BuildFolderReorderItemsParams {
  activeId: string;
  overId: string;
  activeParentFolderId: string | null;
  overParentFolderId: string | null;
  activeSiblingIds: string[];
  overSiblingIds: string[];
  overChildIds: string[];
}

export interface BuildFolderMoveToRootItemsParams {
  activeId: string;
  activeParentFolderId: string | null;
  activeSiblingIds: string[];
  rootSiblingIds: string[];
}

function toReorderItems(
  ids: string[],
  parentFolderId: string | null,
): CatalogFolderReorderItem[] {
  return ids.map((id, index) => ({ id, sortOrder: index, parentFolderId }));
}

export function buildFolderReorderItems({
  activeId,
  overId,
  activeParentFolderId,
  overParentFolderId,
  activeSiblingIds,
  overChildIds,
}: BuildFolderReorderItemsParams): CatalogFolderReorderItem[] | null {
  if (activeId === overId) return null;

  if (activeParentFolderId === overParentFolderId) {
    const oldIdx = activeSiblingIds.indexOf(activeId);
    const newIdx = activeSiblingIds.indexOf(overId);
    if (oldIdx === -1 || newIdx === -1) return null;
    return toReorderItems(arrayMove(activeSiblingIds, oldIdx, newIdx), activeParentFolderId);
  }

  const sourceSiblingIds = activeSiblingIds.filter((id) => id !== activeId);
  const targetChildIds = [...overChildIds.filter((id) => id !== activeId), activeId];
  return [
    ...toReorderItems(sourceSiblingIds, activeParentFolderId),
    ...toReorderItems(targetChildIds, overId),
  ];
}

export function buildFolderMoveToRootItems({
  activeId,
  activeParentFolderId,
  activeSiblingIds,
  rootSiblingIds,
}: BuildFolderMoveToRootItemsParams): CatalogFolderReorderItem[] | null {
  if (activeParentFolderId === null) return null;
  return [
    ...toReorderItems(activeSiblingIds.filter((id) => id !== activeId), activeParentFolderId),
    ...toReorderItems([...rootSiblingIds.filter((id) => id !== activeId), activeId], null),
  ];
}
