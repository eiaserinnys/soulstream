export type BoardAccessFolderRecord = {
  id: string;
  parentFolderId?: string | null;
  settings?: unknown;
};

export type BoardAccess = {
  restricted: boolean;
  allowedFolderIds?: readonly string[];
};

export function normalizeBoardAccess(access: BoardAccess): Required<BoardAccess> {
  return {
    restricted: access.restricted,
    allowedFolderIds: [...(access.allowedFolderIds ?? [])],
  };
}

export function isBoardFolderAllowed(
  access: Required<BoardAccess>,
  folders: readonly BoardAccessFolderRecord[],
  folderId: string | null,
): boolean {
  if (!access.restricted) return true;
  if (folderId === null) return false;
  return visibleFolderIds(access, folders).has(folderId);
}

function visibleFolderIds(
  access: Required<BoardAccess>,
  folders: readonly BoardAccessFolderRecord[],
): Set<string> {
  const knownIds = new Set<string>();
  const byParent = new Map<string | null, string[]>();
  for (const folder of folders) {
    knownIds.add(folder.id);
    const parentId =
      typeof folder.parentFolderId === "string" ? folder.parentFolderId : null;
    const children = byParent.get(parentId) ?? [];
    children.push(folder.id);
    byParent.set(parentId, children);
  }

  const visible = new Set<string>();
  const stack = access.allowedFolderIds.filter((folderId) => knownIds.has(folderId));
  while (stack.length > 0) {
    const folderId = stack.pop();
    if (folderId === undefined || visible.has(folderId)) continue;
    visible.add(folderId);
    stack.push(...(byParent.get(folderId) ?? []));
  }
  return visible;
}
