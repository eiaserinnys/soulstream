import { retainEqualValue } from "@seosoyoung/soul-ui";

import type { PlannerFolder } from "./planner-data";

export function replacePlannerFolder(
  tasks: PlannerFolder[],
  folderId: string,
  update: (task: PlannerFolder) => PlannerFolder,
): PlannerFolder[] {
  let found = false;
  let changed = false;
  const next = tasks.map((task) => {
    if (task.page.id !== folderId) return task;
    found = true;
    const updated = retainEqualValue(task, update(task));
    if (updated !== task) changed = true;
    return updated;
  });
  return found && changed ? next : tasks;
}

export function removePlannerSessions(
  tasks: PlannerFolder[],
  removedIds: ReadonlySet<string>,
): PlannerFolder[] {
  if (removedIds.size === 0) return tasks;
  let changed = false;
  const next = tasks.map((task) => {
    const sessionIds = task.sessionIds.filter((sessionId) => !removedIds.has(sessionId));
    if (sessionIds.length === task.sessionIds.length) return task;
    changed = true;
    return { ...task, sessionIds };
  });
  return changed ? next : tasks;
}

export function movePlannerSession(
  tasks: PlannerFolder[],
  sessionId: string,
  targetFolderId: string,
): PlannerFolder[] {
  let changed = false;
  const next = tasks.map((task) => {
    const withoutSession = task.sessionIds.filter((candidate) => candidate !== sessionId);
    const sessionIds = task.page.id === targetFolderId
      ? [...withoutSession, sessionId]
      : withoutSession;
    if (sameIds(task.sessionIds, sessionIds)) return task;
    changed = true;
    return { ...task, sessionIds };
  });
  return changed ? next : tasks;
}

export function movePlannerFolderProject(
  tasks: PlannerFolder[],
  task: PlannerFolder,
  targetFolderId: string | null,
  visibleFolderId: string,
): PlannerFolder[] {
  if (visibleFolderId !== targetFolderId) {
    const next = tasks.filter((candidate) => candidate.page.id !== task.page.id);
    return next.length === tasks.length ? tasks : next;
  }
  const projected = { ...task, parentFolderId: targetFolderId };
  if (!tasks.some((candidate) => candidate.page.id === task.page.id)) {
    return [...tasks, projected];
  }
  return replacePlannerFolder(tasks, task.page.id, () => projected);
}

function sameIds(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}
