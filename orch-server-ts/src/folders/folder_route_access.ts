export type FolderRecord = {
  id: string;
  parentFolderId?: string | null;
  [key: string]: unknown;
};

export type SessionAssignmentRecord = {
  folderId?: string | null;
  [key: string]: unknown;
};

export type FolderAccess = {
  restricted: boolean;
  allowedFolderIds?: readonly string[];
};

export function normalizeAccess(access: FolderAccess): Required<FolderAccess> {
  return {
    restricted: access.restricted,
    allowedFolderIds: [...(access.allowedFolderIds ?? [])],
  };
}

export function accessPayload(access: Required<FolderAccess>): Required<FolderAccess> {
  return {
    restricted: access.restricted,
    allowedFolderIds: [...access.allowedFolderIds],
  };
}

export function filterFolders(
  access: Required<FolderAccess>,
  folders: readonly FolderRecord[],
): FolderRecord[] {
  const ids = visibleFolderIds(access, folders);
  if (ids === null) return [...folders];
  return folders.filter((folder) => ids.has(folder.id));
}

export function filterSessionAssignments(
  access: Required<FolderAccess>,
  folders: readonly FolderRecord[],
  assignments: Record<string, SessionAssignmentRecord>,
): Record<string, SessionAssignmentRecord> {
  const ids = visibleFolderIds(access, folders);
  if (ids === null) return assignments;
  return Object.fromEntries(
    Object.entries(assignments).filter(([, assignment]) => {
      const folderId = assignment.folderId;
      return typeof folderId === "string" && ids.has(folderId);
    }),
  );
}

export function isFolderAllowed(
  access: Required<FolderAccess>,
  folders: readonly FolderRecord[],
  folderId: string | null,
): boolean {
  if (!access.restricted) return true;
  if (folderId === null) return false;
  return visibleFolderIds(access, folders)?.has(folderId) ?? false;
}

function visibleFolderIds(
  access: Required<FolderAccess>,
  folders: readonly FolderRecord[],
): Set<string> | null {
  if (!access.restricted) return null;
  const knownIds = new Set<string>();
  const byParent = new Map<string | null, string[]>();
  for (const folder of folders) {
    knownIds.add(folder.id);
    const parentId = typeof folder.parentFolderId === "string" ? folder.parentFolderId : null;
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
