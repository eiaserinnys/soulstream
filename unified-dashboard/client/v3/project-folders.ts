import type { CatalogFolder } from "@seosoyoung/soul-ui";

export interface FlatProjectFolder {
  folder: CatalogFolder;
  depth: number;
}

export function flattenProjectFolders(folders: readonly CatalogFolder[]): FlatProjectFolder[] {
  const knownIds = new Set(folders.map((folder) => folder.id));
  const children = new Map<string | null, CatalogFolder[]>();
  for (const folder of folders) {
    const parentId = folder.parentFolderId && knownIds.has(folder.parentFolderId)
      ? folder.parentFolderId
      : null;
    children.set(parentId, [...(children.get(parentId) ?? []), folder]);
  }
  for (const siblings of children.values()) siblings.sort(compareFolders);

  const result: FlatProjectFolder[] = [];
  const visited = new Set<string>();
  const append = (folder: CatalogFolder, depth: number) => {
    if (visited.has(folder.id)) return;
    visited.add(folder.id);
    result.push({ folder, depth });
    for (const child of children.get(folder.id) ?? []) append(child, depth + 1);
  };
  for (const root of children.get(null) ?? []) append(root, 0);
  for (const folder of [...folders].sort(compareFolders)) append(folder, 0);
  return result;
}

function compareFolders(left: CatalogFolder, right: CatalogFolder): number {
  return left.sortOrder - right.sortOrder
    || left.name.localeCompare(right.name, "ko")
    || left.id.localeCompare(right.id);
}
