import type { SessionSummary } from "../shared/types";

export type FolderActiveSessionDecision =
  | { action: "none" }
  | { action: "select"; session: SessionSummary }
  | { action: "clear" };

export interface FolderActiveSessionParams {
  activeSessionKey: string | null;
  isMobile: boolean;
  sessions: readonly SessionSummary[];
}

export function resolveFolderActiveSessionDecision({
  activeSessionKey,
  isMobile,
  sessions,
}: FolderActiveSessionParams): FolderActiveSessionDecision {
  if (isMobile) return { action: "none" };

  if (sessions.length === 0) {
    return activeSessionKey ? { action: "clear" } : { action: "none" };
  }

  if (
    activeSessionKey &&
    sessions.some((session) => session.agentSessionId === activeSessionKey)
  ) {
    return { action: "none" };
  }

  return { action: "select", session: sessions[0] };
}
