import type { CatalogFolder, CatalogState, SessionSummary } from "../shared/types";

export interface FolderBoardWorkspaceItem {
  type: "folder";
  id: string;
  folder: CatalogFolder;
  childCount: number;
  activityMs: number;
}

export interface SessionBoardWorkspaceItem {
  type: "session";
  id: string;
  session: SessionSummary;
  activityMs: number;
}

export type BoardWorkspaceItem = FolderBoardWorkspaceItem | SessionBoardWorkspaceItem;

export interface BuildBoardWorkspaceItemsParams {
  catalog: CatalogState;
  selectedFolderId: string | null;
  sessions: readonly SessionSummary[];
}

function parseTimeMs(value: string | undefined | null): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

export function getSessionActivityMs(session: SessionSummary): number {
  return parseTimeMs(session.lastMessage?.timestamp ?? session.updatedAt ?? session.createdAt);
}

export function getFolderActivityMs(folder: CatalogFolder): number {
  return parseTimeMs(folder.createdAt);
}

export function getSessionBoardTitle(session: SessionSummary): string {
  return session.displayName || session.prompt || session.agentSessionId;
}

export function getSessionBoardPreview(session: SessionSummary): string {
  return session.lastMessage?.preview || session.prompt || "No preview";
}

export function formatBoardWorkspaceTime(value: string | undefined | null): string {
  const ms = parseTimeMs(value);
  if (!ms) return "...";
  return new Date(ms).toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function getFolderDirectChildCount(catalog: CatalogState, folderId: string): number {
  const childFolderCount = catalog.folders.filter(
    (folder) => (folder.parentFolderId ?? null) === folderId,
  ).length;
  const sessionCount = Object.values(catalog.sessions).filter(
    (assignment) => assignment.folderId === folderId,
  ).length;
  return childFolderCount + sessionCount;
}

export function buildBoardWorkspaceItems({
  catalog,
  selectedFolderId,
  sessions,
}: BuildBoardWorkspaceItemsParams): BoardWorkspaceItem[] {
  const folderItems: FolderBoardWorkspaceItem[] = catalog.folders
    .filter((folder) => (folder.parentFolderId ?? null) === selectedFolderId)
    .map((folder) => ({
      type: "folder",
      id: folder.id,
      folder,
      childCount: getFolderDirectChildCount(catalog, folder.id),
      activityMs: getFolderActivityMs(folder),
    }));

  const sessionItems: SessionBoardWorkspaceItem[] = sessions.map((session) => ({
    type: "session",
    id: session.agentSessionId,
    session,
    activityMs: getSessionActivityMs(session),
  }));

  return [...folderItems, ...sessionItems].sort((a, b) => {
    const activityDelta = b.activityMs - a.activityMs;
    if (activityDelta !== 0) return activityDelta;
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    const aTitle = a.type === "folder" ? a.folder.name : getSessionBoardTitle(a.session);
    const bTitle = b.type === "folder" ? b.folder.name : getSessionBoardTitle(b.session);
    return aTitle.localeCompare(bTitle);
  });
}
