import {
  retainEqualValue,
  filterTaskBoardSpatialItems,
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

export type TaskBoardResourceTab =
  | { id: "checklist"; kind: "checklist"; title: string }
  | { id: "sessions"; kind: "sessions"; title: string }
  | { id: string; kind: "document"; title: string; documentId: string };

export function buildTaskBoardResourceTabs(
  boardItems: readonly CatalogBoardItem[],
): TaskBoardResourceTab[] {
  const tabs: TaskBoardResourceTab[] = [
    { id: "checklist", kind: "checklist", title: "체크리스트" },
    { id: "sessions", kind: "sessions", title: "위임 관계" },
  ];
  const seenDocumentIds = new Set<string>();
  for (const item of boardItems) {
    if (item.itemType !== "markdown" || seenDocumentIds.has(item.itemId)) continue;
    seenDocumentIds.add(item.itemId);
    const metadataTitle = item.metadata?.title;
    const title = typeof metadataTitle === "string" && metadataTitle.trim()
      ? metadataTitle.trim()
      : "문서";
    tabs.push({
      id: `document:${item.itemId}`,
      kind: "document",
      title,
      documentId: item.itemId,
    });
  }
  return tabs;
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
  projectFolderId,
  projectTitle,
}: BuildTaskBoardCatalogOptions): CatalogState {
  return {
    folders: projectFolderId
      ? [{ id: projectFolderId, name: projectTitle, sortOrder: 0 }]
      : [],
    sessions: {},
    boardItems: retainEqualValue(
      currentCatalog?.boardItems,
      filterTaskBoardSpatialItems(boardItems),
    ),
    sessionList: [],
  };
}

export function scopeCatalogUpdateToTaskBoard(
  currentCatalog: CatalogState,
  incomingCatalog: CatalogState,
  taskId: string,
): CatalogState {
  const taskBoardItems = incomingCatalog.boardItems === undefined
    ? currentCatalog.boardItems ?? []
    : incomingCatalog.boardItems.filter((item) => (
      item.containerKind === "task" && item.containerId === taskId
    ));

  return {
    ...currentCatalog,
    sessions: {},
    boardItems: filterTaskBoardSpatialItems(taskBoardItems),
    sessionList: [],
  };
}

export function scopeCatalogUpdateToTaskBoardPreservingSessionList(
  currentCatalog: CatalogState,
  incomingCatalog: CatalogState,
  taskId: string,
): CatalogState {
  const scoped = scopeCatalogUpdateToTaskBoard(
    currentCatalog,
    incomingCatalog,
    taskId,
  );
  const sessionList = incomingCatalog.sessionList === undefined
    ? currentCatalog.sessionList
    : retainEqualValue(currentCatalog.sessionList, incomingCatalog.sessionList);
  return sessionList === undefined ? scoped : { ...scoped, sessionList };
}
