import type { PlannerFolder } from '../api/plannerTypes';
import type { Folder } from '../api/types';

export interface PlannerFolderGroup {
  key: string;
  title: string;
  folders: PlannerFolder[];
}

export function groupPlannerFoldersByParent(
  items: readonly PlannerFolder[],
  catalogFolders: readonly Folder[],
): PlannerFolderGroup[] {
  const folderById = new Map(catalogFolders.map((folder) => [folder.id, folder] as const));
  const groups = new Map<string, PlannerFolderGroup>();

  for (const child of items) {
    const folder = child.parentFolderId
      ? folderById.get(child.parentFolderId)
      : undefined;
    const key = folder
      ? `folder:${folder.id}`
      : child.parentFolderId
        ? `folder:missing:${child.parentFolderId}`
        : 'folder:root';
    const title = folder?.name
      ?? (child.parentFolderId ? '연결되지 않은 폴더' : '상위 폴더 없음');
    const group = groups.get(key) ?? { key, title, folders: [] };
    group.folders.push(child);
    groups.set(key, group);
  }
  return [...groups.values()];
}
