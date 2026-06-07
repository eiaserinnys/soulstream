import type { Logger } from "pino";

import type { SessionDB } from "../db/session_db.js";

import {
  BOARD_WORKSPACE_SESSION_LIMIT,
  buildBoardWorkspaceContextItem,
  type BoardWorkspaceSessionSummary,
} from "./board_workspace_item.js";
import type { ContextItem } from "./prompt_assembler.js";

export async function fetchBoardWorkspaceContextItem(
  db: SessionDB,
  logger: Logger,
  folderId?: string,
): Promise<ContextItem | null> {
  if (!folderId) return null;
  try {
    const catalog = await db.getCatalog();
    const folderSessions = await fetchBoardWorkspaceFolderSessions(db, logger, folderId);
    return buildBoardWorkspaceContextItem(folderId, catalog, {
      ...(folderSessions
        ? {
            folderSessions: folderSessions.sessions,
            folderSessionTotal: folderSessions.total,
          }
        : {}),
    });
  } catch (err) {
    logger.warn({ err, folderId }, "fetchBoardWorkspaceContextItem: getCatalog failed");
    return null;
  }
}

export async function fetchRunningSessionsContextItem(
  db: SessionDB,
  logger: Logger,
  currentSessionId: string,
): Promise<ContextItem | null> {
  const listRunningSessionsSummary = (db as unknown as {
    listRunningSessionsSummary?: SessionDB["listRunningSessionsSummary"];
  }).listRunningSessionsSummary;
  if (typeof listRunningSessionsSummary !== "function") return null;

  try {
    const result = await listRunningSessionsSummary.call(db, {
      limit: BOARD_WORKSPACE_SESSION_LIMIT,
      excludeSessionId: currentSessionId,
    });
    const sessions = result.sessions.map((session) => {
      const item: Record<string, unknown> = {
        agent_session_id: session.session_id,
        title: session.display_name ?? session.session_id,
      };
      if (session.node_id) item.node_id = session.node_id;
      if (session.folder_id) item.folder_id = session.folder_id;
      if (session.folder_name) item.folder_name = session.folder_name;
      return item;
    });
    const truncated = result.total > sessions.length;
    return {
      key: "running_sessions",
      label: "Running Soulstream sessions",
      content: {
        status: "ok",
        scope: "cluster_database_running_sessions",
        current_session_id: currentSessionId,
        ...(truncated
          ? {
              running_sessions_truncated: {
                total: result.total,
                shown: sessions.length,
                sort: "updated_at_desc",
                message:
                  `Showing ${sessions.length} most recently active running sessions out of ${result.total}.`,
              },
            }
          : {}),
        sessions,
      },
    };
  } catch (err) {
    logger.warn(
      { err, currentSessionId },
      "fetchRunningSessionsContextItem: listRunningSessionsSummary failed",
    );
    return {
      key: "running_sessions",
      label: "Running Soulstream sessions",
      content: {
        status: "unavailable",
        scope: "cluster_database_running_sessions",
        current_session_id: currentSessionId,
        sessions: [],
        warnings: [
          {
            code: "running_sessions_unavailable",
            message:
              "running sessions unavailable; startup continues without live running session context",
          },
        ],
      },
    };
  }
}

async function fetchBoardWorkspaceFolderSessions(
  db: SessionDB,
  logger: Logger,
  folderId: string,
): Promise<{ sessions: BoardWorkspaceSessionSummary[]; total: number } | null> {
  try {
    const result = await db.listSessionsSummary({
      limit: BOARD_WORKSPACE_SESSION_LIMIT,
      offset: 0,
      folderId,
    });
    return {
      sessions: result.sessions.map((session) => ({
        sessionId: session.session_id,
        displayName: session.display_name,
      })),
      total: result.total,
    };
  } catch (err) {
    logger.warn(
      { err, folderId },
      "fetchBoardWorkspaceFolderSessions: listSessionsSummary failed",
    );
    return null;
  }
}
