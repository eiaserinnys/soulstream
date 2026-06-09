import type { CatalogFolder } from "../shared/types";

const LEADING_EMOJI_CLUSTER_PATTERN =
  /^(?:(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\uFE0E|\uFE0F)?(?:\p{Emoji_Modifier})?(?:\u200D(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\uFE0E|\uFE0F)?(?:\p{Emoji_Modifier})?)*\s*)+/u;

export interface FolderTreeOption {
  folder: CatalogFolder;
  depth: number;
}

export function getFolderNameSortKey(name: string): string {
  const stripped = name.replace(LEADING_EMOJI_CLUSTER_PATTERN, "");
  return stripped.length > 0 ? stripped : name;
}

export function compareFoldersByName(a: CatalogFolder, b: CatalogFolder): number {
  const keyCompare = getFolderNameSortKey(a.name).localeCompare(getFolderNameSortKey(b.name));
  if (keyCompare !== 0) return keyCompare;
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

export function buildFolderTreeOptions(folders: readonly CatalogFolder[]): FolderTreeOption[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const byParent = new Map<string | null, CatalogFolder[]>();

  for (const folder of folders) {
    const parentId =
      folder.parentFolderId && byId.has(folder.parentFolderId)
        ? folder.parentFolderId
        : null;
    const siblings = byParent.get(parentId) ?? [];
    siblings.push(folder);
    byParent.set(parentId, siblings);
  }

  for (const siblings of byParent.values()) {
    siblings.sort(compareFoldersByName);
  }

  const options: FolderTreeOption[] = [];
  const visited = new Set<string>();

  const visit = (folder: CatalogFolder, depth: number) => {
    if (visited.has(folder.id)) return;
    visited.add(folder.id);
    options.push({ folder, depth });
    for (const child of byParent.get(folder.id) ?? []) {
      visit(child, depth + 1);
    }
  };

  for (const root of byParent.get(null) ?? []) {
    visit(root, 0);
  }

  for (const folder of [...folders].sort(compareFoldersByName)) {
    visit(folder, 0);
  }

  return options;
}
