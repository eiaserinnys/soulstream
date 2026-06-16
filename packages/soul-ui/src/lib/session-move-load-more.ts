import type { CatalogState } from "../shared/types";
import type { DashboardViewMode } from "../stores/dashboard-store-types";

export interface SessionMoveLoadMoreState {
  viewMode: DashboardViewMode;
  selectedFolderId: string | null;
  catalog: CatalogState | null;
  sessionIds: readonly string[];
  targetFolderId: string | null;
}

function assignedFolderId(
  catalog: CatalogState,
  sessionId: string,
): string | null {
  return catalog.sessions[sessionId]?.folderId ?? null;
}

function isFeedVisibleFolder(
  catalog: CatalogState,
  folderId: string | null,
): boolean {
  if (folderId === null) return true;
  const folder = catalog.folders.find((entry) => entry.id === folderId);
  return folder?.settings?.excludeFromFeed !== true;
}

export function shouldLoadMoreAfterSessionMove({
  viewMode,
  selectedFolderId,
  catalog,
  sessionIds,
  targetFolderId,
}: SessionMoveLoadMoreState): boolean {
  if (sessionIds.length === 0) return false;
  if (viewMode === "runbooks") return false;

  if (!catalog) {
    if (viewMode === "folder") return targetFolderId !== selectedFolderId;
    return targetFolderId !== null;
  }

  if (viewMode === "folder") {
    return sessionIds.some((sessionId) => (
      assignedFolderId(catalog, sessionId) === selectedFolderId &&
      targetFolderId !== selectedFolderId
    ));
  }

  const targetVisibleInFeed = isFeedVisibleFolder(catalog, targetFolderId);
  if (targetVisibleInFeed) return false;

  return sessionIds.some((sessionId) => (
    isFeedVisibleFolder(catalog, assignedFolderId(catalog, sessionId))
  ));
}
