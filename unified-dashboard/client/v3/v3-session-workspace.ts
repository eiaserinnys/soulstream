import type { CatalogBoardItem, SessionSummary } from "@seosoyoung/soul-ui";

import {
  sessionWorkspaceTargetFromBoardItems,
  type SessionWorkspaceTarget,
} from "./v3-session-panel-model";

export interface ResolvedSessionWorkspace {
  target: SessionWorkspaceTarget;
  loadedBoardItems?: CatalogBoardItem[];
  folderId?: string;
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
  const cached = sessionWorkspaceTargetFromBoardItems(boardItems, session.agentSessionId);
  if (cached) return { target: cached };
  if (!session.folderId) return { target: { kind: "standalone" } };

  const query = new URLSearchParams({ folder_id: session.folderId });
  const response = await fetchImplementation(`/api/board-items?${query.toString()}`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`세션의 업무를 불러오지 못했습니다 (${response.status})`);
  }
  const payload = await response.json() as { boardItems?: CatalogBoardItem[] };
  const loadedBoardItems = payload.boardItems ?? [];
  return {
    target: sessionWorkspaceTargetFromBoardItems(
      loadedBoardItems,
      session.agentSessionId,
    ) ?? { kind: "standalone" },
    loadedBoardItems,
    folderId: session.folderId,
  };
}
