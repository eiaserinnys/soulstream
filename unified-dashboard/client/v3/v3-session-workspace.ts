import type { useTranslation } from "react-i18next";
import type { SessionSummary } from "@seosoyoung/soul-ui";
import type { PlannerFolder } from "./planner-data";

import {
  sessionWorkspaceTarget,
  type SessionWorkspaceTarget,
} from "./v3-session-panel-model";

type Translate = ReturnType<typeof useTranslation>["t"];

export interface ResolvedSessionWorkspace {
  target: SessionWorkspaceTarget;
}

export class SessionWorkspaceResolutionError extends Error {
  constructor(
    public readonly phase: "folder",
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
}: {
  session: SessionSummary;
}): Promise<ResolvedSessionWorkspace> {
  return { target: sessionWorkspaceTarget(session) };
}

export async function resolveSessionFolderWorkspace({
  session,
  currentFolderEntries,
  loadFolderById,
  t,
}: {
  session: SessionSummary;
  currentFolderEntries: readonly PlannerFolder[];
  loadFolderById(folderId: string): Promise<PlannerFolder>;
  t: Translate;
}): Promise<{ workspace: ResolvedSessionWorkspace; task: PlannerFolder | null }> {
  const workspace = await resolveSessionWorkspace({ session });
  if (workspace.target.kind === "standalone") return { workspace, task: null };
  const folderId = workspace.target.folderId;
  const cached = currentFolderEntries.find((task) => task.folderId === folderId);
  if (cached) return { workspace, task: cached };
  try {
    return { workspace, task: await loadFolderById(folderId) };
  } catch (error) {
    throw new SessionWorkspaceResolutionError(
      "folder",
      t("sessions.workspaceFolderLoadFailed"),
      { cause: error },
    );
  }
}
