import type { CatalogBoardItem, SessionSummary } from "@seosoyoung/soul-ui";
import type { PlannerTask } from "./planner-data";

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
    public readonly phase: "membership" | "task",
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
  const cached = sessionWorkspaceTargetFromBoardItems(boardItems, session.agentSessionId);
  if (cached) return { target: cached };

  const query = new URLSearchParams({ session_id: session.agentSessionId });
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
  };
}

export async function resolveSessionTaskWorkspace({
  session,
  boardItems,
  currentTasks,
  loadTask,
  fetchImplementation = globalThis.fetch,
}: {
  session: SessionSummary;
  boardItems: readonly CatalogBoardItem[];
  currentTasks: readonly PlannerTask[];
  loadTask(pageId: string): Promise<PlannerTask>;
  fetchImplementation?: typeof globalThis.fetch;
}): Promise<{ workspace: ResolvedSessionWorkspace; task: PlannerTask | null }> {
  let workspace: ResolvedSessionWorkspace;
  try {
    workspace = await resolveSessionWorkspace({ session, boardItems, fetchImplementation });
  } catch (error) {
    throw new SessionWorkspaceResolutionError(
      "membership",
      "세션의 소속 업무를 확인하지 못했습니다.",
      { cause: error },
    );
  }
  if (workspace.target.kind === "standalone") return { workspace, task: null };
  const { pageId } = workspace.target;
  const cached = currentTasks.find((task) => (
    task.page.id === pageId || task.taskId === pageId
  ));
  if (cached) return { workspace, task: cached };
  try {
    return { workspace, task: await loadTask(pageId) };
  } catch (error) {
    throw new SessionWorkspaceResolutionError(
      "task",
      "소속 업무를 불러오지 못했습니다.",
      { cause: error },
    );
  }
}
