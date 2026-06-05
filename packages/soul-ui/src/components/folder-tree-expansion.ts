const FOLDER_TREE_EXPANDED_STORAGE_PREFIX = "soulstream:folder-tree:expanded:v1:";

export function getFolderTreeExpandedStorageKey(folderId: string): string {
  return `${FOLDER_TREE_EXPANDED_STORAGE_PREFIX}${folderId}`;
}

export function readFolderTreeExpandedState(
  storage: Storage | undefined,
  folderId: string,
): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(getFolderTreeExpandedStorageKey(folderId)) === "true";
  } catch {
    return false;
  }
}

export function writeFolderTreeExpandedState(
  storage: Storage | undefined,
  folderId: string,
  expanded: boolean,
): void {
  if (!storage) return;
  try {
    storage.setItem(getFolderTreeExpandedStorageKey(folderId), expanded ? "true" : "false");
  } catch {
    // Storage can be unavailable in private mode. The in-memory state still works.
  }
}
