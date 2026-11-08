import {
  getSessionActivityMs,
  type CatalogFolder,
  type SessionSummary,
} from "@seosoyoung/soul-ui";

import { singleLinePreview } from "./session-preview";
import {
  sessionPresentationStatus,
  type SessionNodeConnectivity,
} from "./session-node-connectivity";

const SESSION_PANEL_TITLE_LENGTH = 80;

export interface SessionPanelGroups {
  running: SessionSummary[];
  offline: SessionSummary[];
  review: SessionSummary[];
}

export type SessionWorkspaceTarget =
  | { kind: "folder"; folderId: string }
  | { kind: "standalone" };

export function sessionPanelGroups(
  sessions: readonly SessionSummary[],
  connectivity: SessionNodeConnectivity = {
    ready: false,
    connectedNodeIds: new Set(),
  },
  acknowledgedReviewIds: ReadonlySet<string> = new Set(),
): SessionPanelGroups {
  const recentFirst = (left: SessionSummary, right: SessionSummary) =>
    sessionTimestamp(right) - sessionTimestamp(left)
      || right.agentSessionId.localeCompare(left.agentSessionId);
  return {
    running: sessions
      .filter((session) => sessionPresentationStatus(session, connectivity) === "running")
      .sort(recentFirst),
    offline: sessions
      .filter((session) => sessionPresentationStatus(session, connectivity) === "offline")
      .sort(recentFirst),
    review: sessions
      .filter((session) => (
        session.status === "completed" && session.reviewState === "needs_review"
          && !acknowledgedReviewIds.has(session.agentSessionId)
      ))
      .sort(recentFirst),
  };
}

export function sessionPanelTitle(session: SessionSummary): string {
  return singleLinePreview(session.displayName, SESSION_PANEL_TITLE_LENGTH)
    ?? singleLinePreview(session.lastMessage?.preview, SESSION_PANEL_TITLE_LENGTH)
    ?? "제목 없는 세션";
}

export function sessionWorkspaceTarget(session: Pick<SessionSummary, "folderId">): SessionWorkspaceTarget {
  return session.folderId ? { kind: "folder", folderId: session.folderId } : { kind: "standalone" };
}

export function sessionPanelAffiliation(
  folders: readonly CatalogFolder[],
  folderId: string | null | undefined,
): string | null {
  return folders.find((folder) => folder.id === folderId)?.name.trim() || null;
}

function sessionTimestamp(session: SessionSummary): number {
  return getSessionActivityMs(session);
}
