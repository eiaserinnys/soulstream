import type { CatalogFolderRow } from "../db/session_db.js";

import type { ContextItem } from "./prompt_assembler.js";

interface BoardWorkspaceCatalog {
  folders: CatalogFolderRow[];
  sessions: Record<string, { folderId: string | null; displayName: string | null }>;
}

export const BOARD_WORKSPACE_SESSION_LIMIT = 15;

export interface BoardWorkspaceSessionSummary {
  sessionId: string;
  displayName: string | null;
}

export interface BoardWorkspaceContextOptions {
  folderSessions?: BoardWorkspaceSessionSummary[];
  folderSessionTotal?: number;
}

export function buildBoardWorkspaceContextItem(
  folderId: string | null | undefined,
  catalog: BoardWorkspaceCatalog,
  options: BoardWorkspaceContextOptions = {},
): ContextItem | null {
  if (!folderId) return null;

  const folders = catalog.folders
    .filter((folder) => folder.parentFolderId === folderId)
    .map((folder) => ({
      id: folder.id,
      name: folder.name,
      direct_child_count: countDirectChildren(catalog, folder.id),
    }));

  const folderSessions = options.folderSessions ?? fallbackFolderSessions(catalog, folderId);
  const sessions = folderSessions
    .slice(0, BOARD_WORKSPACE_SESSION_LIMIT)
    .map(toFolderSessionContext);
  const totalSessionCount = options.folderSessionTotal ?? folderSessions.length;
  const sessionsTruncated = totalSessionCount > sessions.length;

  return {
    key: "board_workspace",
    label: "Board workspace",
    content: {
      folder_id: folderId,
      folders,
      ...(sessionsTruncated
        ? {
            sessions_truncated: {
              total: totalSessionCount,
              shown: sessions.length,
              sort: "updated_at_desc",
              message:
                `Showing ${sessions.length} most recently active sessions out of ${totalSessionCount}.`,
            },
          }
        : {}),
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

function fallbackFolderSessions(
  catalog: BoardWorkspaceCatalog,
  folderId: string,
): BoardWorkspaceSessionSummary[] {
  return Object.entries(catalog.sessions)
    .filter(([, assignment]) => assignment.folderId === folderId)
    .map(([agentSessionId, assignment]) => ({
      sessionId: agentSessionId,
      displayName: assignment.displayName,
    }));
}

function toFolderSessionContext(session: BoardWorkspaceSessionSummary): Record<string, unknown> {
  return {
    agent_session_id: session.sessionId,
    title: session.displayName ?? session.sessionId,
  };
}
