import type { ContextItem } from "@soulstream/wire-schema";

export const BOARD_WORKSPACE_SESSION_LIMIT = 15;

export interface BoardWorkspaceSessionSummary {
  sessionId: string;
  displayName: string | null;
}

export interface BoardWorkspaceChildFolder {
  id: string;
  name: string;
  directChildCount: number;
}

export interface BoardWorkspaceFolderSessions {
  sessions: BoardWorkspaceSessionSummary[];
  total: number;
}

export function buildBoardWorkspaceContextItem(
  folderId: string,
  childFolders: readonly BoardWorkspaceChildFolder[],
  folderSessions: BoardWorkspaceFolderSessions,
): ContextItem {
  const folders = childFolders.map((folder) => ({
    id: folder.id,
    name: folder.name,
    direct_child_count: folder.directChildCount,
  }));
  const sessions = folderSessions.sessions
    .slice(0, BOARD_WORKSPACE_SESSION_LIMIT)
    .map(toFolderSessionContext);
  const totalSessionCount = folderSessions.total;
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

function toFolderSessionContext(session: BoardWorkspaceSessionSummary): Record<string, unknown> {
  return {
    agent_session_id: session.sessionId,
    title: session.displayName ?? session.sessionId,
  };
}
