import type { Folder } from '../api/types';

export interface FolderTreeRow<T extends Folder = Folder> {
  folder: T;
  depth: number;
  hasChildren: boolean;
  childCount: number;
  isExpanded: boolean;
}

export interface FolderMoveTarget {
  folderId: string | null;
  label: string;
  disabled: boolean;
}

export interface FolderReorderItem {
  id: string;
  sortOrder: number;
  parentFolderId: string | null;
}

export type ReorderDirection = 'up' | 'down';

interface TreeProjectionOptions {
  expandedFolderIds?: ReadonlySet<string>;
  expandAll?: boolean;
}

const DEFAULT_INDENT_STEP = 16;
const DEFAULT_MAX_INDENT_DEPTH = 5;

function compareFolders(a: Folder, b: Folder): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  const byName = a.name.localeCompare(b.name);
  if (byName !== 0) return byName;
  return a.id.localeCompare(b.id);
}

function getRawParentId(folder: Folder): string | null {
  return folder.parentFolderId ?? null;
}

function buildChildrenMap(folders: readonly Folder[]): Map<string | null, Folder[]> {
  const knownIds = new Set(folders.map((folder) => folder.id));
  const children = new Map<string | null, Folder[]>();

  for (const folder of folders) {
    const rawParentId = getRawParentId(folder);
    const parentId = rawParentId && knownIds.has(rawParentId) ? rawParentId : null;
    const siblings = children.get(parentId) ?? [];
    siblings.push(folder);
    children.set(parentId, siblings);
  }

  for (const siblings of children.values()) {
    siblings.sort(compareFolders);
  }

  return children;
}

export function getChildFolders(
  folders: readonly Folder[],
  parentFolderId: string | null,
): Folder[] {
  return buildChildrenMap(folders).get(parentFolderId) ?? [];
}

export function buildFolderTreeRows(
  folders: readonly Folder[],
  options: TreeProjectionOptions = {},
): FolderTreeRow[] {
  const children = buildChildrenMap(folders);
  const rows: FolderTreeRow[] = [];
  const visited = new Set<string>();
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const sortedFolders = [...folders].sort(compareFolders);

  const visit = (folder: Folder, depth: number, ancestors: Set<string>) => {
    if (visited.has(folder.id)) return;
    visited.add(folder.id);

    const childFolders = children.get(folder.id) ?? [];
    const hasChildren = childFolders.length > 0;
    const isExpanded =
      !!options.expandAll || !!options.expandedFolderIds?.has(folder.id);

    rows.push({
      folder,
      depth,
      hasChildren,
      childCount: childFolders.length,
      isExpanded,
    });

    if (!hasChildren || !isExpanded) return;
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(folder.id);
    for (const child of childFolders) {
      if (nextAncestors.has(child.id)) continue;
      visit(child, depth + 1, nextAncestors);
    }
  };

  for (const root of children.get(null) ?? []) {
    visit(root, 0, new Set());
  }

  const hasVisitedAncestor = (folder: Folder): boolean => {
    const seen = new Set<string>();
    let cursor = getRawParentId(folder);
    while (cursor) {
      if (visited.has(cursor)) return true;
      if (seen.has(cursor)) return false;
      seen.add(cursor);
      const parent = byId.get(cursor);
      if (!parent) return false;
      cursor = getRawParentId(parent);
    }
    return false;
  };

  // Broken or cyclic server data should not make folders disappear from the app.
  // Collapsed descendants are intentionally hidden, so do not rescue nodes whose
  // ancestor is already visible.
  for (const folder of sortedFolders) {
    if (!visited.has(folder.id) && !hasVisitedAncestor(folder)) {
      visit(folder, 0, new Set());
    }
  }

  return rows;
}

export function isFolderMoveBlocked(
  folders: readonly Folder[],
  folderId: string,
  targetParentFolderId: string | null,
): boolean {
  if (!targetParentFolderId) return false;
  if (targetParentFolderId === folderId) return true;

  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const seen = new Set<string>();
  let cursor: string | null = targetParentFolderId;

  while (cursor) {
    if (cursor === folderId) return true;
    if (seen.has(cursor)) return false;
    seen.add(cursor);
    const parent = byId.get(cursor);
    if (!parent) return false;
    cursor = getRawParentId(parent);
  }

  return false;
}

export function formatFolderDepthLabel(name: string, depth: number): string {
  if (depth <= 0) return name;
  return `${'› '.repeat(depth)}${name}`;
}

export function folderTreeIndent(
  depth: number,
  step = DEFAULT_INDENT_STEP,
  maxDepth = DEFAULT_MAX_INDENT_DEPTH,
): number {
  return Math.min(Math.max(depth, 0), maxDepth) * step;
}

export function buildFolderMoveTargets(
  folders: readonly Folder[],
  movingFolderId: string,
): FolderMoveTarget[] {
  const movingFolder = folders.find((folder) => folder.id === movingFolderId);
  const currentParentId = movingFolder ? getRawParentId(movingFolder) : null;
  const rows = buildFolderTreeRows(folders, { expandAll: true });

  return [
    {
      folderId: null,
      label: '최상위 폴더',
      disabled: currentParentId === null,
    },
    ...rows.map((row) => {
      const targetFolderId = row.folder.id;
      const invalidTarget = isFolderMoveBlocked(
        folders,
        movingFolderId,
        targetFolderId,
      );
      return {
        folderId: targetFolderId,
        label: formatFolderDepthLabel(row.folder.name, row.depth),
        disabled: invalidTarget || currentParentId === targetFolderId,
      };
    }),
  ];
}

export function buildSessionFolderTargets(
  folders: readonly Folder[],
  currentFolderId: string | null,
): FolderMoveTarget[] {
  const rows = buildFolderTreeRows(folders, { expandAll: true });
  return [
    {
      folderId: null,
      label: '미분류',
      disabled: currentFolderId === null,
    },
    ...rows.map((row) => ({
      folderId: row.folder.id,
      label: formatFolderDepthLabel(row.folder.name, row.depth),
      disabled: currentFolderId === row.folder.id,
    })),
  ];
}

export function buildFolderMoveItems(
  folders: readonly Folder[],
  folderId: string,
  targetParentFolderId: string | null,
): FolderReorderItem[] | null {
  const movingFolder = folders.find((folder) => folder.id === folderId);
  if (!movingFolder) return null;
  if (isFolderMoveBlocked(folders, folderId, targetParentFolderId)) return null;

  const currentParentId = getRawParentId(movingFolder);
  if (currentParentId === targetParentFolderId) return null;

  const sourceItems = getChildFolders(folders, currentParentId)
    .filter((folder) => folder.id !== folderId)
    .map((folder, index) => ({
      id: folder.id,
      sortOrder: index,
      parentFolderId: currentParentId,
    }));
  const targetItems = [
    ...getChildFolders(folders, targetParentFolderId).filter(
      (folder) => folder.id !== folderId,
    ),
    movingFolder,
  ].map((folder, index) => ({
    id: folder.id,
    sortOrder: index,
    parentFolderId: targetParentFolderId,
  }));

  return [...sourceItems, ...targetItems];
}

export function buildFolderSiblingReorderItems(
  folders: readonly Folder[],
  folderId: string,
  direction: ReorderDirection,
): FolderReorderItem[] | null {
  const folder = folders.find((item) => item.id === folderId);
  if (!folder) return null;
  const parentFolderId = getRawParentId(folder);
  const siblings = getChildFolders(folders, parentFolderId);
  const index = siblings.findIndex((item) => item.id === folderId);
  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || targetIndex < 0 || targetIndex >= siblings.length) return null;

  const reordered = [...siblings];
  const current = reordered[index];
  const target = reordered[targetIndex];
  if (!current || !target) return null;
  reordered[index] = target;
  reordered[targetIndex] = current;

  return reordered.map((item, nextIndex) => ({
    id: item.id,
    sortOrder: nextIndex,
    parentFolderId,
  }));
}
