import type { PageApiClient, PageDto } from "@seosoyoung/soul-ui/page";
import type { CatalogFolder } from "@seosoyoung/soul-ui";

const TASK_MOVE_SEARCH_LIMIT = 8;

export interface FolderMoveTarget {
  page: PageDto;
  folderId: string;
}

export function defaultFolderMoveTargets(
  targets: readonly FolderMoveTarget[],
  currentFolderId: string,
): FolderMoveTarget[] {
  return [...new Map(
    targets
      .filter((target) => target.folderId !== currentFolderId)
      .map((target) => [target.folderId, target]),
  ).values()];
}

export async function searchFolderMoveTargets(
  api: PageApiClient,
  query: string,
  currentFolderId: string,
  folders: readonly CatalogFolder[],
): Promise<FolderMoveTarget[]> {
  const normalized = query.trim();
  if (!normalized) return [];
  const matches = folders.filter((folder) => !folder.archived && folder.id !== currentFolderId
    && folder.projectPageId && folder.name.toLocaleLowerCase().includes(normalized.toLocaleLowerCase()))
    .slice(0, TASK_MOVE_SEARCH_LIMIT);
  const snapshots = await Promise.all(
    matches.map((folder) => api.getPage(folder.projectPageId!)),
  );
  const targets = snapshots.map((snapshot, index) => ({ page: snapshot.page, folderId: matches[index]!.id }));
  return defaultFolderMoveTargets(targets, currentFolderId);
}
