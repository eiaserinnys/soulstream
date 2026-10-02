import {
  getSessionActivityMs,
  type CatalogBoardItem,
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

export function sessionWorkspaceTargetFromBoardItems(
  boardItems: readonly CatalogBoardItem[],
  sessionId: string,
): SessionWorkspaceTarget | null {
  const primary = primarySessionBoardItem(boardItems, sessionId);
  if (!primary) return null;
  return { kind: "folder", folderId: primary.folderId };
}

export function sessionPanelAffiliation(
  boardItems: readonly CatalogBoardItem[],
  folders: readonly CatalogFolder[],
  sessionId: string,
  assignedFolderId?: string | null,
): string | null {
  const folderId = assignedFolderId === undefined ? primarySessionBoardItem(boardItems, sessionId)?.folderId : assignedFolderId;
  return folders.find((folder) => folder.id === folderId)?.name.trim() || null;
}

function primarySessionBoardItem(
  boardItems: readonly CatalogBoardItem[],
  sessionId: string,
): CatalogBoardItem | undefined {
  return boardItems.find((item) => (
    item.itemType === "session"
      && item.itemId === sessionId
      && (item.membershipKind ?? "primary") === "primary"
  ));
}

function sessionTimestamp(session: SessionSummary): number {
  return getSessionActivityMs(session);
}
