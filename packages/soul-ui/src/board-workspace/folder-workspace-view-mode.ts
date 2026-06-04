import { useCallback, useEffect, useState } from "react";

export type FolderWorkspaceViewMode = "list" | "board";

const STORAGE_PREFIX = "soulstream:folder-workspace:view-mode:v1:";
export const FOLDER_WORKSPACE_ROOT_STORAGE_ID = "__root__";

export function getFolderWorkspaceViewModeStorageKey(folderId: string | null): string {
  return `${STORAGE_PREFIX}${folderId ?? FOLDER_WORKSPACE_ROOT_STORAGE_ID}`;
}

function isFolderWorkspaceViewMode(value: string | null): value is FolderWorkspaceViewMode {
  return value === "list" || value === "board";
}

export function readFolderWorkspaceViewMode(
  storage: Pick<Storage, "getItem"> | null | undefined,
  folderId: string | null,
): FolderWorkspaceViewMode {
  if (!storage) return "list";
  try {
    const value = storage.getItem(getFolderWorkspaceViewModeStorageKey(folderId));
    return isFolderWorkspaceViewMode(value) ? value : "list";
  } catch {
    return "list";
  }
}

export function writeFolderWorkspaceViewMode(
  storage: Pick<Storage, "setItem"> | null | undefined,
  folderId: string | null,
  mode: FolderWorkspaceViewMode,
): void {
  if (!storage) return;
  try {
    storage.setItem(getFolderWorkspaceViewModeStorageKey(folderId), mode);
  } catch {
    // Private mode or blocked storage should not break folder navigation.
  }
}

function getBrowserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function useFolderWorkspaceViewMode(folderId: string | null) {
  const [mode, setModeState] = useState<FolderWorkspaceViewMode>(() =>
    readFolderWorkspaceViewMode(getBrowserStorage(), folderId),
  );

  useEffect(() => {
    setModeState(readFolderWorkspaceViewMode(getBrowserStorage(), folderId));
  }, [folderId]);

  const setMode = useCallback(
    (nextMode: FolderWorkspaceViewMode) => {
      setModeState(nextMode);
      writeFolderWorkspaceViewMode(getBrowserStorage(), folderId, nextMode);
    },
    [folderId],
  );

  return [mode, setMode] as const;
}
