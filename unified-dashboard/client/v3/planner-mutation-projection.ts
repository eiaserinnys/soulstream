import { retainEqualValue } from "@seosoyoung/soul-ui";

import type { PlannerTask } from "./planner-data";

export function replacePlannerTask(
  tasks: PlannerTask[],
  taskId: string,
  update: (task: PlannerTask) => PlannerTask,
): PlannerTask[] {
  let found = false;
  let changed = false;
  const next = tasks.map((task) => {
    if (task.page.id !== taskId) return task;
    found = true;
    const updated = retainEqualValue(task, update(task));
    if (updated !== task) changed = true;
    return updated;
  });
  return found && changed ? next : tasks;
}

export function removePlannerSessions(
  tasks: PlannerTask[],
  removedIds: ReadonlySet<string>,
): PlannerTask[] {
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
  tasks: PlannerTask[],
  sessionId: string,
  targetTaskId: string,
): PlannerTask[] {
  let changed = false;
  const next = tasks.map((task) => {
    const withoutSession = task.sessionIds.filter((candidate) => candidate !== sessionId);
    const sessionIds = task.page.id === targetTaskId
      ? [...withoutSession, sessionId]
      : withoutSession;
    if (sameIds(task.sessionIds, sessionIds)) return task;
    changed = true;
    return { ...task, sessionIds };
  });
  return changed ? next : tasks;
}

function sameIds(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}
