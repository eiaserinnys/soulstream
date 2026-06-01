import type { SessionSummary, TaskItem, TaskStatus } from "../shared";

export interface TaskTreeRow {
  task: TaskItem;
  depth: number;
  isLast: boolean;
  ancestorLast: boolean[];
  hasChildren: boolean;
}

const USER_COMPLETED_STATUSES = new Set<TaskStatus>(["verified_done"]);
export const TASK_DETAIL_SPLIT_DEFAULT_TOP_PERCENT = 64;
export const TASK_DETAIL_SPLIT_MIN_TOP_PX = 160;
export const TASK_DETAIL_SPLIT_MIN_BOTTOM_PX = 160;

export function clampTaskDetailSplitTopPercent(
  topPercent: number,
  containerHeight: number,
): number {
  if (!Number.isFinite(topPercent)) return TASK_DETAIL_SPLIT_DEFAULT_TOP_PERCENT;
  if (!Number.isFinite(containerHeight) || containerHeight <= 0) {
    return TASK_DETAIL_SPLIT_DEFAULT_TOP_PERCENT;
  }
  const minTopPercent = (TASK_DETAIL_SPLIT_MIN_TOP_PX / containerHeight) * 100;
  const maxTopPercent = 100 - (TASK_DETAIL_SPLIT_MIN_BOTTOM_PX / containerHeight) * 100;
  return Math.max(minTopPercent, Math.min(maxTopPercent, topPercent));
}

export function buildTaskTreeRows(
  tasks: readonly TaskItem[],
  options: { hideCompleted?: boolean } = {},
): TaskTreeRow[] {
  const subtreeUpdatedAt = buildSubtreeUpdatedAt(tasks);
  const visibleTasks = options.hideCompleted
    ? tasks.filter((task) => !USER_COMPLETED_STATUSES.has(task.status))
    : [...tasks];
  const children = new Map<string | null, TaskItem[]>();

  for (const task of visibleTasks) {
    const key = task.parentId ?? null;
    const bucket = children.get(key) ?? [];
    bucket.push(task);
    children.set(key, bucket);
  }
  for (const bucket of children.values()) {
    bucket.sort((a, b) => compareTaskSiblings(a, b, subtreeUpdatedAt));
  }

  const rows: TaskTreeRow[] = [];
  const seen = new Set<string>();
  const visit = (task: TaskItem, depth: number, isLast: boolean, ancestorLast: boolean[]) => {
    if (seen.has(task.id)) return;
    seen.add(task.id);
    const childTasks = children.get(task.id) ?? [];
    rows.push({ task, depth, isLast, ancestorLast, hasChildren: childTasks.length > 0 });
    childTasks.forEach((child, index) => {
      visit(child, depth + 1, index === childTasks.length - 1, [...ancestorLast, isLast]);
    });
  };

  const roots = children.get(null) ?? [];
  roots.forEach((root, index) => {
    visit(root, 0, index === roots.length - 1, []);
  });
  for (const task of visibleTasks) {
    if (!seen.has(task.id)) {
      visit(task, 0, true, []);
    }
  }
  return rows;
}

export function buildTaskStreamUrl(lastEventId?: string, instanceId?: string): string {
  const params = new URLSearchParams();
  if (lastEventId) params.set("lastEventId", lastEventId);
  if (instanceId) params.set("instanceId", instanceId);
  const qs = params.toString();
  return `/api/tasks/stream${qs ? `?${qs}` : ""}`;
}

export function resolveTaskTreeHeaderAction(onNewSession?: () => void):
  | { visible: true; label: string; title: string }
  | { visible: false } {
  if (!onNewSession) return { visible: false };
  return { visible: true, label: "New", title: "New session" };
}

export function resolveTaskNavigationSummary(
  sessionById: ReadonlyMap<string, SessionSummary>,
  sessionId: string,
  task?: TaskItem,
): SessionSummary {
  const visibleSession = sessionById.get(sessionId);
  if (visibleSession) return visibleSession;
  if (task?.linkedSession?.agentSessionId === sessionId) {
    return task.linkedSession;
  }
  const fallbackNodeId =
    task?.navigationSessionId === sessionId
      ? task.navigationNodeId ?? task.linkedNodeId ?? undefined
      : task?.linkedSessionId === sessionId
        ? task.linkedNodeId ?? undefined
        : undefined;
  return {
    agentSessionId: sessionId,
    status: "unknown",
    eventCount: 0,
    displayName: sessionId,
    nodeId: fallbackNodeId,
  };
}

export function resolveLinkedTaskSession(
  task: TaskItem,
  sessionById: ReadonlyMap<string, SessionSummary>,
): SessionSummary | undefined {
  if (!task.linkedSessionId) return undefined;
  return sessionById.get(task.linkedSessionId) ??
    (task.linkedSession?.agentSessionId === task.linkedSessionId
      ? task.linkedSession
      : undefined);
}

function buildSubtreeUpdatedAt(tasks: readonly TaskItem[]): ReadonlyMap<string, number> {
  const byParent = new Map<string, TaskItem[]>();
  for (const task of tasks) {
    if (!task.parentId) continue;
    const bucket = byParent.get(task.parentId) ?? [];
    bucket.push(task);
    byParent.set(task.parentId, bucket);
  }

  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const resolve = (task: TaskItem): number => {
    if (memo.has(task.id)) return memo.get(task.id)!;
    if (visiting.has(task.id)) return taskUpdatedAt(task);
    visiting.add(task.id);
    let latest = taskUpdatedAt(task);
    for (const child of byParent.get(task.id) ?? []) {
      latest = Math.max(latest, resolve(child));
    }
    visiting.delete(task.id);
    memo.set(task.id, latest);
    return latest;
  };

  for (const task of tasks) {
    resolve(task);
  }
  return memo;
}

function compareTaskSiblings(
  a: TaskItem,
  b: TaskItem,
  subtreeUpdatedAt: ReadonlyMap<string, number>,
): number {
  return (
    taskSortRank(a) - taskSortRank(b) ||
    (subtreeUpdatedAt.get(b.id) ?? taskUpdatedAt(b)) -
      (subtreeUpdatedAt.get(a.id) ?? taskUpdatedAt(a)) ||
    a.positionKey - b.positionKey ||
    a.createdAt.localeCompare(b.createdAt) ||
    a.id.localeCompare(b.id)
  );
}

function taskUpdatedAt(task: TaskItem): number {
  const timestamp = Date.parse(task.updatedAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function taskSortRank(task: TaskItem): number {
  if (task.pinned) return 0;
  switch (task.status) {
    case "open":
    case "in_progress":
    case "reopened":
      return 1;
    case "blocked":
    case "cancelled":
      return 2;
    case "agent_done":
    case "verified_done":
      return 3;
  }
}
