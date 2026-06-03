import type { CatalogFolder, CatalogState } from "../shared/types";

export function getChildFolders(
  folders: readonly CatalogFolder[],
  parentFolderId: string | null,
): CatalogFolder[] {
  return folders
    .filter((folder) => (folder.parentFolderId ?? null) === parentFolderId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

export function getRootFolders(folders: readonly CatalogFolder[]): CatalogFolder[] {
  return getChildFolders(folders, null);
}

export function getFolderBreadcrumbs(
  folders: readonly CatalogFolder[],
  folderId: string | null,
): CatalogFolder[] {
  if (!folderId) return [];
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const path: CatalogFolder[] = [];
  const seen = new Set<string>();
  let current = byId.get(folderId);

  while (current && !seen.has(current.id)) {
    path.push(current);
    seen.add(current.id);
    current = current.parentFolderId ? byId.get(current.parentFolderId) : undefined;
  }

  return path.reverse();
}

export function getFolderDirectChildCount(
  catalog: CatalogState,
  folderId: string,
): number {
  const childFolderCount = catalog.folders.filter(
    (folder) => (folder.parentFolderId ?? null) === folderId,
  ).length;
  const sessionCount = Object.values(catalog.sessions).filter(
    (assignment) => assignment.folderId === folderId,
  ).length;
  return childFolderCount + sessionCount;
}
