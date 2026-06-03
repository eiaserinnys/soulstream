import type { CatalogFolderRow } from "../db/session_db.js";

import type { ContextItem } from "./prompt_assembler.js";

interface BoardWorkspaceCatalog {
  folders: CatalogFolderRow[];
  sessions: Record<string, { folderId: string | null; displayName: string | null }>;
}

export function buildBoardWorkspaceContextItem(
  folderId: string | null | undefined,
  catalog: BoardWorkspaceCatalog,
): ContextItem | null {
  if (!folderId) return null;

  const folders = catalog.folders
    .filter((folder) => folder.parentFolderId === folderId)
    .map((folder) => ({
      id: folder.id,
      name: folder.name,
      direct_child_count: countDirectChildren(catalog, folder.id),
    }));

  const sessions = Object.entries(catalog.sessions)
    .filter(([, assignment]) => assignment.folderId === folderId)
    .map(([agentSessionId, assignment]) => ({
      agent_session_id: agentSessionId,
      title: assignment.displayName ?? agentSessionId,
    }));

  return {
    key: "board_workspace",
    label: "Board workspace",
    content: {
      folder_id: folderId,
      folders,
      sessions,
    },
  };
}

function countDirectChildren(catalog: BoardWorkspaceCatalog, folderId: string): number {
  const folderCount = catalog.folders.filter((folder) => folder.parentFolderId === folderId).length;
  const sessionCount = Object.values(catalog.sessions).filter(
    (assignment) => assignment.folderId === folderId,
  ).length;
  return folderCount + sessionCount;
}
