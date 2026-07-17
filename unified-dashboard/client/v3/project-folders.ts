import type { CatalogFolder } from "@seosoyoung/soul-ui";

export interface FlatProjectFolder {
  folder: CatalogFolder;
  depth: number;
}

export interface ProjectFolderTreeNode {
  folder: CatalogFolder;
  children: ProjectFolderTreeNode[];
}

export function buildProjectFolderTree(
  folders: readonly CatalogFolder[],
): ProjectFolderTreeNode[] {
  const knownIds = new Set(folders.map((folder) => folder.id));
  const children = new Map<string | null, CatalogFolder[]>();
  for (const folder of folders) {
    const parentId = folder.parentFolderId && knownIds.has(folder.parentFolderId)
      ? folder.parentFolderId
      : null;
    children.set(parentId, [...(children.get(parentId) ?? []), folder]);
  }
  for (const siblings of children.values()) siblings.sort(compareFolders);

  const visited = new Set<string>();
  const build = (folder: CatalogFolder, ancestors: ReadonlySet<string>): ProjectFolderTreeNode => {
    visited.add(folder.id);
    const nextAncestors = new Set(ancestors).add(folder.id);
    return {
      folder,
      children: (children.get(folder.id) ?? [])
        .filter((child) => !nextAncestors.has(child.id))
        .map((child) => build(child, nextAncestors)),
    };
  };
  const roots = (children.get(null) ?? []).map((folder) => build(folder, new Set()));
  for (const folder of [...folders].sort(compareFolders)) {
    if (!visited.has(folder.id)) roots.push(build(folder, new Set()));
  }
  return roots;
}

export function flattenProjectFolders(folders: readonly CatalogFolder[]): FlatProjectFolder[] {
  const result: FlatProjectFolder[] = [];
  const append = (node: ProjectFolderTreeNode, depth: number) => {
    result.push({ folder: node.folder, depth });
    for (const child of node.children) append(child, depth + 1);
  };
  for (const root of buildProjectFolderTree(folders)) append(root, 0);
  return result;
}

function compareFolders(left: CatalogFolder, right: CatalogFolder): number {
  return left.sortOrder - right.sortOrder
    || left.name.localeCompare(right.name, "ko")
    || left.id.localeCompare(right.id);
}
