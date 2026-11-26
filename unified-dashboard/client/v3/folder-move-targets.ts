import type { PageDto } from "../../../packages/page-model/src/types";

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
