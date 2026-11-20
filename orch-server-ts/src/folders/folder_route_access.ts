import {
  isBoardFolderAllowed,
  normalizeBoardAccess,
  visibleBoardFolderIds,
  type BoardAccess,
  type BoardAccessFolderRecord,
} from "../board/board_access.js";

export type FolderRecord = BoardAccessFolderRecord & { [key: string]: unknown };

export type SessionAssignmentRecord = {
  folderId?: string | null;
  [key: string]: unknown;
};

export type FolderAccess = BoardAccess;

export {
  isBoardFolderAllowed as isFolderAllowed,
  normalizeBoardAccess as normalizeAccess,
};

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
  if (!access.restricted) return [...folders];
  const ids = visibleBoardFolderIds(access, folders);
  return folders.filter((folder) => ids.has(folder.id));
}

export function filterSessionAssignments(
  access: Required<FolderAccess>,
  folders: readonly FolderRecord[],
  assignments: Record<string, SessionAssignmentRecord>,
): Record<string, SessionAssignmentRecord> {
  if (!access.restricted) return assignments;
  const ids = visibleBoardFolderIds(access, folders);
  return Object.fromEntries(
    Object.entries(assignments).filter(([, assignment]) => {
      const folderId = assignment.folderId;
      return typeof folderId === "string" && ids.has(folderId);
    }),
  );
}
