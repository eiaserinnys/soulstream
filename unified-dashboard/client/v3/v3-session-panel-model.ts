import type { CatalogBoardItem, SessionSummary } from "@seosoyoung/soul-ui";

import { singleLinePreview } from "./session-preview";

const SESSION_PANEL_TITLE_LENGTH = 80;

export interface SessionPanelGroups {
  running: SessionSummary[];
  review: SessionSummary[];
}

export type SessionWorkspaceTarget =
  | { kind: "task"; pageId: string }
  | { kind: "standalone" };

export function sessionPanelGroups(
  sessions: readonly SessionSummary[],
): SessionPanelGroups {
  const recentFirst = (left: SessionSummary, right: SessionSummary) =>
    sessionTimestamp(right) - sessionTimestamp(left)
      || right.agentSessionId.localeCompare(left.agentSessionId);
  return {
    running: sessions.filter((session) => session.status === "running").sort(recentFirst),
    review: sessions
      .filter((session) => (
        session.status === "completed" && session.reviewState === "needs_review"
      ))
      .sort(recentFirst),
  };
}

export function sessionPanelTitle(session: SessionSummary): string {
  return singleLinePreview(session.displayName, SESSION_PANEL_TITLE_LENGTH)
    ?? singleLinePreview(session.lastMessage?.preview, SESSION_PANEL_TITLE_LENGTH)
    ?? "제목 없는 세션";
}

export function sessionWorkspaceTargetFromBoardItems(
  boardItems: readonly CatalogBoardItem[],
  sessionId: string,
): SessionWorkspaceTarget | null {
  const primary = boardItems.find((item) => (
    item.itemType === "session"
      && item.itemId === sessionId
      && (item.membershipKind ?? "primary") === "primary"
  ));
  if (!primary) return null;
  const containerKind = primary.containerKind ?? "folder";
  const containerId = primary.containerId ?? primary.folderId;
  return containerKind === "runbook"
    ? { kind: "task", pageId: containerId }
    : { kind: "standalone" };
}

function sessionTimestamp(session: SessionSummary): number {
  const value = session.updatedAt
    ?? session.lastMessage?.timestamp
    ?? session.completedAt
    ?? session.createdAt;
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}
