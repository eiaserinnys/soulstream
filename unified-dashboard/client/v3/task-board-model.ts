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
  | { id: string; kind: "document"; title: string; documentId: string }
  | { id: string; kind: "custom_view"; title: string; customViewId: string };

export type TaskBoardResourceSelection =
  | { kind: "document"; resourceId: string }
  | { kind: "custom_view"; resourceId: string };

export interface TaskBoardResourceState {
  openedResources: TaskBoardResourceSelection[];
  activeTabId: string;
}

export function initialTaskBoardResourceState(): TaskBoardResourceState {
  return {
    openedResources: [],
    activeTabId: "checklist",
  };
}

export function taskBoardResourceTabId(resource: TaskBoardResourceSelection): string {
  return resource.kind === "document"
    ? `document:${resource.resourceId}`
    : `custom-view:${resource.resourceId}`;
}

export function openTaskBoardResource(
  state: TaskBoardResourceState,
  resource: TaskBoardResourceSelection,
): TaskBoardResourceState {
  const tabId = taskBoardResourceTabId(resource);
  const alreadyOpen = state.openedResources.some((candidate) => (
    taskBoardResourceTabId(candidate) === tabId
  ));
  if (alreadyOpen && state.activeTabId === tabId) return state;
  return {
    openedResources: alreadyOpen
      ? state.openedResources
      : [...state.openedResources, resource],
    activeTabId: tabId,
  };
}

export function buildTaskBoardResourceTabs(
  boardItems: readonly CatalogBoardItem[],
  openedResources: readonly TaskBoardResourceSelection[] = [],
): TaskBoardResourceTab[] {
  const tabs: TaskBoardResourceTab[] = [
    { id: "checklist", kind: "checklist", title: "체크리스트" },
    { id: "sessions", kind: "sessions", title: "위임 관계" },
  ];
  const seenTabIds = new Set<string>();
  for (const resource of openedResources) {
    const tabId = taskBoardResourceTabId(resource);
    if (seenTabIds.has(tabId)) continue;
    const itemType = resource.kind === "document" ? "markdown" : "custom_view";
    const item = boardItems.find((candidate) => (
      candidate.itemType === itemType && candidate.itemId === resource.resourceId
    ));
    if (!item) continue;
    seenTabIds.add(tabId);
    const metadataTitle = item.metadata?.title;
    const title = typeof metadataTitle === "string" && metadataTitle.trim()
      ? metadataTitle.trim()
      : resource.kind === "document" ? "문서" : "Flux";
    tabs.push(resource.kind === "document"
      ? {
          id: tabId,
          kind: "document",
          title,
          documentId: resource.resourceId,
        }
      : {
          id: tabId,
          kind: "custom_view",
          title,
          customViewId: resource.resourceId,
        });
  }
  return tabs;
}

export function reconcileTaskBoardResourceState(
  state: TaskBoardResourceState,
  boardItems: readonly CatalogBoardItem[],
): TaskBoardResourceState {
  const openedResources = state.openedResources.filter((resource) => {
    const itemType = resource.kind === "document" ? "markdown" : "custom_view";
    return boardItems.some((item) => (
      item.itemType === itemType && item.itemId === resource.resourceId
    ));
  });
  const activeTabIds = new Set(
    buildTaskBoardResourceTabs(boardItems, openedResources).map((tab) => tab.id),
  );
  const activeTabId = activeTabIds.has(state.activeTabId)
    ? state.activeTabId
    : "checklist";
  const resourcesUnchanged = openedResources.length === state.openedResources.length
    && openedResources.every((resource, index) => resource === state.openedResources[index]);
  if (resourcesUnchanged && activeTabId === state.activeTabId) return state;
  return { openedResources, activeTabId };
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
