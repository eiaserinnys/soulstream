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
    { id: "sessions", kind: "sessions", title: "세션" },
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

export const TASK_RESOURCE_MIN_WIDTH_PX = 240;
export const TASK_RESOURCE_MAX_WIDTH_PX = 560;
export const TASK_CHAT_MIN_WIDTH_PX = 320;
export const TASK_CHAT_MAX_WIDTH_PX = 560;

/**
 * 좌측 업무 자료 패널 폭을 안전 범위로 clamp한다. 최소값은 그리드 좌 컬럼의
 * `minmax(240px, ...)` 하한과 일치하고, 최대값은 고정 상한을 둔다. 좌·우 패널이
 * 동시에 최대여도 그리드의 중앙 1fr 트랙이 남는 공간을 흡수해 오른쪽 채팅 열을
 * 밀어내거나 오버플로하지 않는다(각 패널은 자기 min 이하로 줄지 않는다).
 */
export function clampTaskResourceWidth(widthPx: number): number {
  if (Number.isNaN(widthPx)) return TASK_RESOURCE_MIN_WIDTH_PX;
  return Math.min(
    TASK_RESOURCE_MAX_WIDTH_PX,
    Math.max(TASK_RESOURCE_MIN_WIDTH_PX, widthPx),
  );
}

/**
 * 오른쪽 채팅 패널 폭을 안전 범위로 clamp한다. 최소값은 그리드 우 컬럼의
 * `minmax(320px, ...)` 하한과 일치한다. 좌측 리사이즈와 독립적으로 적용되며
 * 기존 세션 패널 리사이즈와 동일하게 `--v3-session-panel-width` 토큰에 반영한다.
 */
export function clampTaskChatWidth(widthPx: number): number {
  if (Number.isNaN(widthPx)) return TASK_CHAT_MIN_WIDTH_PX;
  return Math.min(
    TASK_CHAT_MAX_WIDTH_PX,
    Math.max(TASK_CHAT_MIN_WIDTH_PX, widthPx),
  );
}

export interface TabStripOverflow {
  canScrollLeft: boolean;
  canScrollRight: boolean;
}

/**
 * 탭 스트립의 가로 스크롤 상태로부터 좌/우 셰브론 노출 여부를 계산한다(순수).
 * 1px 허용 오차로 부동소수 반올림 흔들림을 흡수한다. 넘치지 않으면 둘 다 false.
 */
export function computeTabStripOverflow(metrics: {
  scrollLeft: number;
  clientWidth: number;
  scrollWidth: number;
}): TabStripOverflow {
  const maxScroll = metrics.scrollWidth - metrics.clientWidth;
  if (maxScroll <= 1) return { canScrollLeft: false, canScrollRight: false };
  return {
    canScrollLeft: metrics.scrollLeft > 1,
    canScrollRight: metrics.scrollLeft < maxScroll - 1,
  };
}
