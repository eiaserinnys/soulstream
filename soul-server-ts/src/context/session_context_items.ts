import type { Logger } from "pino";

import type { SessionDB } from "../db/session_db.js";
import type { RunningSessionSummaryRow } from "../db/session_db_types.js";
import {
  isSessionDataHostError,
  type SessionResumeContext,
} from "../control_plane/session_data_host_client.js";

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
  preloaded?: SessionResumeContext["folderSessions"],
): Promise<ContextItem | null> {
  if (!folderId) return null;
  try {
    const catalog = await db.getCatalog();
    const folderSessions = preloaded
      ? {
          sessions: preloaded.sessions.map((session) => ({
            sessionId: session.session_id,
            displayName: session.display_name,
          })),
          total: preloaded.total,
        }
      : await fetchBoardWorkspaceFolderSessions(db, logger, folderId);
    return buildBoardWorkspaceContextItem(folderId, catalog, {
      ...(folderSessions
        ? {
            folderSessions: folderSessions.sessions,
            folderSessionTotal: folderSessions.total,
          }
        : {}),
    });
  } catch (err) {
    if (isSessionDataHostError(err)) throw err;
    logger.warn({ err, folderId }, "fetchBoardWorkspaceContextItem: getCatalog failed");
    return null;
  }
}

export async function fetchRunningSessionsContextItem(
  db: SessionDB,
  logger: Logger,
  currentSessionId: string,
  preloaded?: SessionResumeContext["runningSessions"],
): Promise<ContextItem | null> {
  const listRunningSessionsSummary = (db as unknown as {
    listRunningSessionsSummary?: SessionDB["listRunningSessionsSummary"];
  }).listRunningSessionsSummary;
  if (typeof listRunningSessionsSummary !== "function") return null;

  try {
    const result = preloaded ?? await listRunningSessionsSummary.call(db, {
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
    if (isSessionDataHostError(err)) throw err;
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

export const RUNNING_SESSIONS_SNAPSHOT_LIMIT = 200;

export interface RunningSessionsSnapshot {
  sessions: RunningSessionSummaryRow[];
  total: number;
}

/**
 * 후속 턴 delta 계산용 실행 중 세션 스냅샷.
 * 조회 수단이 없거나 실패하면 null — 호출자는 running_sessions 항목을 싣지 않는다.
 */
export async function fetchRunningSessionsSnapshot(
  db: SessionDB,
  logger: Logger,
  currentSessionId: string,
): Promise<RunningSessionsSnapshot | null> {
  const listRunningSessionsSummary = (db as unknown as {
    listRunningSessionsSummary?: SessionDB["listRunningSessionsSummary"];
  }).listRunningSessionsSummary;
  if (typeof listRunningSessionsSummary !== "function") return null;

  try {
    return await listRunningSessionsSummary.call(db, {
      limit: RUNNING_SESSIONS_SNAPSHOT_LIMIT,
      excludeSessionId: currentSessionId,
    });
  } catch (err) {
    if (isSessionDataHostError(err)) throw err;
    logger.warn(
      { err, currentSessionId },
      "fetchRunningSessionsSnapshot: listRunningSessionsSummary failed",
    );
    return null;
  }
}

/** 마지막으로 모델에 알린 실행 중 세션 집합. 집합이 잘렸으면 undefined. */
export function toRunningSessionsMarker(
  snapshot: RunningSessionsSnapshot,
): Record<string, string> | undefined {
  if (snapshot.total > snapshot.sessions.length) return undefined;
  const marker: Record<string, string> = {};
  for (const session of snapshot.sessions) {
    marker[session.session_id] = session.display_name ?? session.session_id;
  }
  return marker;
}

/** 직전 마커와 지금 스냅샷의 차이(새 세션, 끝난 세션)만 싣는다. 변화가 없으면 null. */
export function buildRunningSessionsDeltaContextItem(
  previous: Record<string, string>,
  snapshot: RunningSessionsSnapshot,
  currentSessionId: string,
): ContextItem | null {
  const started: Array<Record<string, unknown>> = [];
  const ended: Array<{ agent_session_id: string; title: string }> = [];
  const currentIds = new Set<string>();
  for (const session of snapshot.sessions) {
    currentIds.add(session.session_id);
    if (Object.hasOwn(previous, session.session_id)) continue;
    const item: Record<string, unknown> = {
      agent_session_id: session.session_id,
      title: session.display_name ?? session.session_id,
    };
    if (session.node_id) item.node_id = session.node_id;
    if (session.folder_id) item.folder_id = session.folder_id;
    if (session.folder_name) item.folder_name = session.folder_name;
    started.push(item);
  }
  for (const [sessionId, title] of Object.entries(previous)) {
    if (!currentIds.has(sessionId)) {
      ended.push({ agent_session_id: sessionId, title });
    }
  }
  if (started.length === 0 && ended.length === 0) return null;
  return {
    key: "running_sessions",
    label: "Running Soulstream sessions (changes since previous turn)",
    content: {
      status: "ok",
      scope: "cluster_database_running_sessions",
      mode: "delta",
      current_session_id: currentSessionId,
      running_total: snapshot.total,
      started,
      ended,
      message:
        "Only changes since the previous turn. Sessions not listed are unchanged. Use list_sessions for the full list.",
    },
  };
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
    if (isSessionDataHostError(err)) throw err;
    logger.warn(
      { err, folderId },
      "fetchBoardWorkspaceFolderSessions: listSessionsSummary failed",
    );
    return null;
  }
}
