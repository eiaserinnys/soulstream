import type { CatalogBoardItem, SessionSummary } from "@seosoyoung/soul-ui";
import type { PlannerFolder } from "./planner-data";

import {
  sessionWorkspaceTargetFromBoardItems,
  type SessionWorkspaceTarget,
} from "./v3-session-panel-model";

export interface ResolvedSessionWorkspace {
  target: SessionWorkspaceTarget;
  loadedBoardItems?: CatalogBoardItem[];
}

export class SessionWorkspaceResolutionError extends Error {
  constructor(
    public readonly phase: "membership" | "folder",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SessionWorkspaceResolutionError";
  }
}

export async function resolveSessionForOpen({
  sessionId,
  knownSession,
  fetchSessions,
}: {
  sessionId: string;
  knownSession?: SessionSummary;
  fetchSessions(options: { sessionIds: readonly string[] }): Promise<{
    sessions: SessionSummary[];
  }>;
}): Promise<SessionSummary | null> {
  if (knownSession?.agentSessionId === sessionId) return knownSession;
  const result = await fetchSessions({ sessionIds: [sessionId] });
  return result.sessions.find((session) => session.agentSessionId === sessionId) ?? null;
}

export async function resolveSessionWorkspace({
  session,
  boardItems,
  fetchImplementation = globalThis.fetch,
}: {
  session: SessionSummary;
  boardItems: readonly CatalogBoardItem[];
  fetchImplementation?: typeof globalThis.fetch;
}): Promise<ResolvedSessionWorkspace> {
  if (session.folderId) return { target: { kind: "folder", folderId: session.folderId } };
  const cached = sessionWorkspaceTargetFromBoardItems(boardItems, session.agentSessionId);
  if (cached) return { target: cached };

  const query = new URLSearchParams({ sessionId: session.agentSessionId });
  const response = await fetchImplementation(`/api/board-items?${query.toString()}`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`세션의 폴더를 불러오지 못했습니다 (${response.status})`);
  }
  const payload = await response.json() as { boardItems?: CatalogBoardItem[] };
  const loadedBoardItems = payload.boardItems ?? [];
  return {
    target: sessionWorkspaceTargetFromBoardItems(
      loadedBoardItems,
      session.agentSessionId,
    ) ?? { kind: "standalone" },
    loadedBoardItems,
  };
}

export async function resolveSessionFolderWorkspace({
  session,
  boardItems,
  currentFolderEntries,
  loadFolderById,
  fetchImplementation = globalThis.fetch,
}: {
  session: SessionSummary;
  boardItems: readonly CatalogBoardItem[];
  currentFolderEntries: readonly PlannerFolder[];
  loadFolderById(folderId: string): Promise<PlannerFolder>;
  fetchImplementation?: typeof globalThis.fetch;
}): Promise<{ workspace: ResolvedSessionWorkspace; task: PlannerFolder | null }> {
  let workspace: ResolvedSessionWorkspace;
  try {
    workspace = await resolveSessionWorkspace({ session, boardItems, fetchImplementation });
  } catch (error) {
    throw new SessionWorkspaceResolutionError(
      "membership",
      "세션의 소속 폴더를 확인하지 못했습니다.",
      { cause: error },
    );
  }
  if (workspace.target.kind === "standalone") return { workspace, task: null };
  const folderId = workspace.target.folderId;
  const cached = currentFolderEntries.find((task) => task.folderId === folderId);
  if (cached) return { workspace, task: cached };
  try {
    return { workspace, task: await loadFolderById(folderId) };
  } catch (error) {
    throw new SessionWorkspaceResolutionError(
      "folder",
      "소속 폴더를 불러오지 못했습니다.",
      { cause: error },
    );
  }
}
