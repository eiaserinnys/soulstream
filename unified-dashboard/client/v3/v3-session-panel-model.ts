import type { useTranslation } from "react-i18next";
import type { SessionNodeConnectivity } from "@seosoyoung/soul-ui/lib/session-node-connectivity";
import {
  getSessionActivityMs,
  type CatalogFolder,
  type SessionSummary,
} from "@seosoyoung/soul-ui";

import { singleLinePreview, visibleLastMessagePreview } from "./session-preview";
import {
  sessionPresentationStatus,
} from "./session-node-connectivity";

type Translate = ReturnType<typeof useTranslation>["t"];

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

export function sessionPanelTitle(session: SessionSummary, t: Translate): string {
  return singleLinePreview(session.displayName, SESSION_PANEL_TITLE_LENGTH)
    ?? singleLinePreview(visibleLastMessagePreview(session), SESSION_PANEL_TITLE_LENGTH)
    ?? t("sessions.untitledSession");
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
