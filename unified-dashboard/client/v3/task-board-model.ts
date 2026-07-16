import {
  retainEqualValue,
  type CatalogAssignment,
  type CatalogBoardItem,
  type CatalogState,
  type SessionSummary,
} from "@seosoyoung/soul-ui";

interface BuildTaskBoardCatalogOptions {
  currentCatalog: CatalogState | null;
  boardItems: readonly CatalogBoardItem[];
  sessions: readonly SessionSummary[];
  projectFolderId: string | null;
  projectTitle: string;
}

export function extractTaskBoardSessionIds(
  boardItems: readonly CatalogBoardItem[],
): string[] {
  return [...new Set(boardItems
    .filter((item) => item.itemType === "session")
    .map((item) => item.itemId)
    .filter(Boolean))].sort();
}

export function mergeTaskBoardSessions(
  plannerSessions: readonly SessionSummary[],
  boardSessions: readonly SessionSummary[],
): SessionSummary[] {
  const byId = new Map(plannerSessions.map((session) => [session.agentSessionId, session]));
  for (const session of boardSessions) byId.set(session.agentSessionId, session);
  return [...byId.values()];
}

export function buildTaskBoardCatalog({
  currentCatalog,
  boardItems,
  sessions,
  projectFolderId,
  projectTitle,
}: BuildTaskBoardCatalogOptions): CatalogState {
  const sessionIds = new Set(extractTaskBoardSessionIds(boardItems));
  const scopedSessions = sessions.filter((session) => sessionIds.has(session.agentSessionId));
  const summaryById = new Map(scopedSessions.map((session) => [session.agentSessionId, session]));
  const assignmentFolderById = new Map(
    boardItems
      .filter((item) => item.itemType === "session")
      .map((item) => [item.itemId, item.folderId || projectFolderId]),
  );
  const assignments: Record<string, CatalogAssignment> = {};
  for (const sessionId of sessionIds) {
    const current = currentCatalog?.sessions[sessionId];
    const summary = summaryById.get(sessionId);
    assignments[sessionId] = {
      folderId: current?.folderId ?? assignmentFolderById.get(sessionId) ?? projectFolderId,
      displayName: summary?.displayName !== undefined
        ? summary.displayName ?? null
        : current?.displayName ?? null,
    };
  }

  return {
    folders: projectFolderId
      ? [{ id: projectFolderId, name: projectTitle, sortOrder: 0 }]
      : [],
    sessions: assignments,
    boardItems: [...boardItems],
    sessionList: scopedSessions,
  };
}

export function scopeCatalogUpdateToTaskBoard(
  currentCatalog: CatalogState,
  incomingCatalog: CatalogState,
  runbookId: string,
): CatalogState {
  const nextBoardItems = incomingCatalog.boardItems === undefined
    ? currentCatalog.boardItems ?? []
    : incomingCatalog.boardItems.filter((item) => (
      item.containerKind === "runbook" && item.containerId === runbookId
    ));
  const sessionIds = new Set(extractTaskBoardSessionIds(nextBoardItems));
  const sessions: Record<string, CatalogAssignment> = {};
  for (const sessionId of sessionIds) {
    const assignment = incomingCatalog.sessions[sessionId] ?? currentCatalog.sessions[sessionId];
    if (assignment) sessions[sessionId] = assignment;
  }

  const incomingById = new Map(
    (incomingCatalog.sessionList ?? [])
      .filter((session) => sessionIds.has(session.agentSessionId))
      .map((session) => [session.agentSessionId, session]),
  );
  const sessionList = [...sessionIds].flatMap((sessionId) => {
    const incoming = incomingById.get(sessionId);
    if (incoming) return [incoming];
    const current = currentCatalog.sessionList?.find(
      (session) => session.agentSessionId === sessionId,
    );
    return current ? [current] : [];
  });

  return {
    ...currentCatalog,
    sessions,
    boardItems: nextBoardItems,
    sessionList,
  };
}

export function scopeCatalogUpdateToTaskBoardPreservingSessionList(
  currentCatalog: CatalogState,
  incomingCatalog: CatalogState,
  runbookId: string,
): CatalogState {
  const scoped = scopeCatalogUpdateToTaskBoard(
    currentCatalog,
    incomingCatalog,
    runbookId,
  );
  const sessionList = incomingCatalog.sessionList === undefined
    ? currentCatalog.sessionList
    : retainEqualValue(currentCatalog.sessionList, incomingCatalog.sessionList);
  return sessionList === undefined ? scoped : { ...scoped, sessionList };
}
