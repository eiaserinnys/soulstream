import type { FolderStarChange } from "./task-star-store";
import {
  isPlannerFolder,
  type StarredPlannerFolder,
} from "./planner-data";

export function mergeStarredPlannerFolders(
  first: readonly StarredPlannerFolder[],
  second: readonly StarredPlannerFolder[],
): StarredPlannerFolder[] {
  return [...new Map([...first, ...second].map((task) => [taskPageId(task), task])).values()];
}

export function isStarredPlannerPageCurrent(
  current: { items: readonly StarredPlannerFolder[]; nextCursor: string | null } | null,
  expectedPageIds: readonly string[],
  expectedCursor: string,
): boolean {
  return current !== null
    && current.nextCursor === expectedCursor
    && current.items.length === expectedPageIds.length
    && current.items.every((task, index) => taskPageId(task) === expectedPageIds[index]);
}

export function applyStarredPlannerFolderChanges(
  tasks: readonly StarredPlannerFolder[],
  changes: readonly FolderStarChange[],
): StarredPlannerFolder[] {
  const byId = new Map(tasks.map((task) => [taskPageId(task), task]));
  for (const change of changes) {
    if (!change.starred) {
      byId.delete(change.page.id);
      continue;
    }
    const current = byId.get(change.page.id);
    byId.set(
      change.page.id,
      current && isPlannerFolder(current) ? { ...current, page: change.page } : change.page,
    );
  }
  return [...byId.values()];
}

function taskPageId(task: StarredPlannerFolder): string {
  return isPlannerFolder(task) ? task.page.id : task.id;
}
