import type { SessionSummary } from "@seosoyoung/soul-ui";

import type { PageSessionDefaults } from "./task-workspace-api";

export interface SessionPageAnchor {
  pageId: string;
  blockId: string;
  expectedVersion: number;
}

export function buildSuccessionCreateOptions({
  inheritCard,
  inheritSummary,
  pageAnchor,
  predecessorSessionId,
}: {
  inheritCard: boolean;
  inheritSummary: boolean;
  pageAnchor: SessionPageAnchor | null;
  predecessorSessionId: string | null;
}): { pageAnchor?: SessionPageAnchor; predecessorSessionId?: string } {
  return {
    ...(inheritCard && pageAnchor ? { pageAnchor } : {}),
    ...(inheritSummary && predecessorSessionId ? { predecessorSessionId } : {}),
  };
}

export function resolveRunAssignmentDefaults({
  pageDefaults,
  currentSession,
}: {
  pageDefaults: PageSessionDefaults | null;
  currentSession: SessionSummary | null;
}): { agentId: string | null; nodeId: string | null; source: "page-defaults" | "current-session" | "none" } {
  const agentId = pageDefaults?.agentId ?? currentSession?.agentId ?? null;
  const nodeId = pageDefaults?.nodeId ?? currentSession?.nodeId ?? null;
  const source = pageDefaults && (pageDefaults.agentId || pageDefaults.nodeId)
    ? "page-defaults"
    : currentSession && (currentSession.agentId || currentSession.nodeId)
      ? "current-session"
      : "none";
  return { agentId, nodeId, source };
}

export function latestTaskRun(
  sessionIds: readonly string[],
  sessions: readonly SessionSummary[],
): SessionSummary | null {
  const allowed = new Set(sessionIds);
  return sessions
    .filter((session) => allowed.has(session.agentSessionId))
    .sort((left, right) => sessionTime(right) - sessionTime(left))[0] ?? null;
}

function sessionTime(session: SessionSummary): number {
  const parsed = Date.parse(session.createdAt ?? session.updatedAt ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}
