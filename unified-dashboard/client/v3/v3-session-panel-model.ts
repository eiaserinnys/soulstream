import type { CatalogBoardItem, CatalogFolder, SessionSummary } from "@seosoyoung/soul-ui";

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
  | { kind: "task"; pageId: string }
  | { kind: "standalone" };

export function sessionPanelGroups(
  sessions: readonly SessionSummary[],
  connectivity: SessionNodeConnectivity = {
    ready: false,
    connectedNodeIds: new Set(),
  },
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
  const containerKind = primary.containerKind ?? "folder";
  const containerId = primary.containerId ?? primary.folderId;
  return containerKind === "runbook"
    ? { kind: "task", pageId: containerId }
    : { kind: "standalone" };
}

export function sessionPanelAffiliation(
  boardItems: readonly CatalogBoardItem[],
  folders: readonly CatalogFolder[],
  sessionId: string,
): string | null {
  const primary = primarySessionBoardItem(boardItems, sessionId);
  if (!primary) return null;
  const containerKind = primary.containerKind ?? "folder";
  const containerId = primary.containerId ?? primary.folderId;
  if (containerKind === "folder") {
    return folders.find((folder) => folder.id === containerId)?.name.trim() || null;
  }

  const taskItem = boardItems.find((item) => (
    item.itemType === "runbook"
      && item.itemId === containerId
      && (item.membershipKind ?? "primary") === "primary"
  ));
  const taskTitle = metadataTitle(taskItem);
  if (!taskItem || !taskTitle) return null;
  const projectName = folders.find((folder) => (
    folder.id === taskItem.folderId && Boolean(folder.projectPageId)
  ))?.name.trim();
  return projectName ? `${taskTitle} · ${projectName}` : taskTitle;
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

function metadataTitle(item: CatalogBoardItem | undefined): string | null {
  const title = item?.metadata?.title;
  return typeof title === "string" ? title.trim() || null : null;
}

function sessionTimestamp(session: SessionSummary): number {
  const value = session.updatedAt
    ?? session.lastMessage?.timestamp
    ?? session.completedAt
    ?? session.createdAt;
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}
