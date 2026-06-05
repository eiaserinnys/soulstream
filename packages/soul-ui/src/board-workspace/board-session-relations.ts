import type {
  CatalogBoardItem,
  CatalogFolder,
  CatalogState,
  SessionSummary,
} from "../shared/types";

export interface SessionParentRef {
  parentSessionId: string;
  parentFolderId: string | null;
  parentFolderName: string;
  parentAvailable: boolean;
}

export interface SessionChildStack {
  count: number;
  status: "running" | "error" | "completed";
}

export interface BoardSessionRelationIndex {
  catalog: CatalogState;
  sessions: SessionSummary[];
  sessionById: Map<string, SessionSummary>;
  childrenByParentId: Map<string, SessionSummary[]>;
  parentIdByChildId: Map<string, string>;
  folderById: Map<string, CatalogFolder>;
}

export interface DirectChildPortalItem {
  session: SessionSummary;
  folderId: string | null;
  folderName: string;
  isSameFolder: boolean;
}

export interface BuildBoardSessionRelationsParams {
  catalog: CatalogState;
  sessions: readonly SessionSummary[];
}

function parseTimeMs(value: string | undefined | null): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function getRelationSortMs(session: SessionSummary): number {
  return parseTimeMs(session.updatedAt ?? session.createdAt);
}

function compactFirstLine(value: string | undefined | null): string {
  return value?.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

export function getChildSessionFirstLine(session: SessionSummary): string {
  return compactFirstLine(session.prompt) || "(준비 중)";
}

function isUserReadableMessageType(type: string | undefined): boolean {
  return type === "user" || type === "user_message" || type === "intervention_sent";
}

export function getChildSessionLastLine(session: SessionSummary): string {
  if (isUserReadableMessageType(session.lastMessage?.type)) return getChildSessionFirstLine(session);
  return compactFirstLine(session.lastMessage?.preview) || getChildSessionFirstLine(session);
}

function getChildStackStatus(children: readonly SessionSummary[]): SessionChildStack["status"] {
  if (children.some((session) => session.status === "error")) return "error";
  if (children.some((session) => session.status === "running")) return "running";
  return "completed";
}

function mergeSessionLists(
  catalog: CatalogState,
  sessions: readonly SessionSummary[],
): SessionSummary[] {
  const byId = new Map<string, SessionSummary>();
  for (const session of catalog.sessionList ?? []) {
    const assignment = catalog.sessions[session.agentSessionId];
    byId.set(session.agentSessionId, {
      ...session,
      ...(assignment?.displayName ? { displayName: assignment.displayName } : {}),
    });
  }
  for (const session of sessions) {
    const current = byId.get(session.agentSessionId);
    byId.set(session.agentSessionId, current ? { ...current, ...session } : session);
  }
  return Array.from(byId.values());
}

export function getSessionFolderId(
  catalog: CatalogState,
  sessionId: string,
): string | null {
  return catalog.sessions[sessionId]?.folderId ?? null;
}

export function getFolderDisplayName(
  relationIndex: BoardSessionRelationIndex,
  folderId: string | null,
): string {
  if (folderId === null) return "Uncategorized";
  return relationIndex.folderById.get(folderId)?.name ?? folderId;
}

export function buildBoardSessionRelations({
  catalog,
  sessions,
}: BuildBoardSessionRelationsParams): BoardSessionRelationIndex {
  const mergedSessions = mergeSessionLists(catalog, sessions);
  const sessionById = new Map(mergedSessions.map((session) => [session.agentSessionId, session]));
  const childrenByParentId = new Map<string, SessionSummary[]>();
  const parentIdByChildId = new Map<string, string>();
  const folderById = new Map(catalog.folders.map((folder) => [folder.id, folder]));

  for (const session of mergedSessions) {
    const parentId = session.callerSessionId;
    if (!parentId || parentId === session.agentSessionId) continue;
    parentIdByChildId.set(session.agentSessionId, parentId);
    const children = childrenByParentId.get(parentId) ?? [];
    children.push(session);
    childrenByParentId.set(parentId, children);
  }

  for (const children of childrenByParentId.values()) {
    children.sort((a, b) =>
      getRelationSortMs(b) - getRelationSortMs(a) ||
      a.agentSessionId.localeCompare(b.agentSessionId),
    );
  }

  return {
    catalog,
    sessions: mergedSessions,
    sessionById,
    childrenByParentId,
    parentIdByChildId,
    folderById,
  };
}

export function getSessionParentRef(
  relationIndex: BoardSessionRelationIndex,
  sessionId: string,
): SessionParentRef | null {
  const parentSessionId = relationIndex.parentIdByChildId.get(sessionId);
  if (!parentSessionId) return null;
  const parentFolderId = getSessionFolderId(relationIndex.catalog, parentSessionId);
  const parentAvailable = relationIndex.sessionById.has(parentSessionId);
  return {
    parentSessionId,
    parentFolderId,
    parentFolderName: parentAvailable
      ? getFolderDisplayName(relationIndex, parentFolderId)
      : "Parent unavailable",
    parentAvailable,
  };
}

export function getSessionChildStack(
  relationIndex: BoardSessionRelationIndex,
  sessionId: string,
): SessionChildStack | undefined {
  const children = relationIndex.childrenByParentId.get(sessionId) ?? [];
  return children.length > 0 ? { count: children.length, status: getChildStackStatus(children) } : undefined;
}

export function shouldSuppressSessionInFolder(
  relationIndex: BoardSessionRelationIndex,
  sessionId: string,
  selectedFolderId: string | null,
): boolean {
  const parentSessionId = relationIndex.parentIdByChildId.get(sessionId);
  if (!parentSessionId || !relationIndex.sessionById.has(parentSessionId)) return false;
  const childFolderId = getSessionFolderId(relationIndex.catalog, sessionId);
  const parentFolderId = getSessionFolderId(relationIndex.catalog, parentSessionId);
  return childFolderId === selectedFolderId && parentFolderId === childFolderId;
}

export function getDirectChildPortalItems(
  relationIndex: BoardSessionRelationIndex,
  parentSessionId: string,
  selectedFolderId: string | null,
): DirectChildPortalItem[] {
  return (relationIndex.childrenByParentId.get(parentSessionId) ?? []).map((session) => {
    const folderId = getSessionFolderId(relationIndex.catalog, session.agentSessionId);
    return {
      session,
      folderId,
      folderName: getFolderDisplayName(relationIndex, folderId),
      isSameFolder: folderId === selectedFolderId,
    };
  });
}

export function getSameFolderChildBoardItemIdsToRemove(
  catalog: CatalogState,
  relationIndex: BoardSessionRelationIndex,
  selectedFolderId: string | null,
): string[] {
  const selectedId = selectedFolderId ?? "";
  return (catalog.boardItems ?? [])
    .filter((item): item is CatalogBoardItem & { itemType: "session" } =>
      item.folderId === selectedId &&
      item.itemType === "session" &&
      shouldSuppressSessionInFolder(relationIndex, item.itemId, selectedFolderId),
    )
    .map((item) => item.id);
}
