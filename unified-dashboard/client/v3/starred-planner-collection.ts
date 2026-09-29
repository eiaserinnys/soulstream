import type { FolderStarChange } from "./folder-star-store";
import {
  isPlannerFolder,
  type StarredPlannerFolder,
} from "./planner-data";

export function mergeStarredPlannerFolders(
  first: readonly StarredPlannerFolder[],
  second: readonly StarredPlannerFolder[],
): StarredPlannerFolder[] {
  return [...new Map([...first, ...second].map((task) => [folderPageId(task), task])).values()];
}

export function isStarredPlannerPageCurrent(
  current: { items: readonly StarredPlannerFolder[]; nextCursor: string | null } | null,
  expectedPageIds: readonly string[],
  expectedCursor: string,
): boolean {
  return current !== null
    && current.nextCursor === expectedCursor
    && current.items.length === expectedPageIds.length
    && current.items.every((task, index) => folderPageId(task) === expectedPageIds[index]);
}

export function applyStarredPlannerFolderChanges(
  tasks: readonly StarredPlannerFolder[],
  changes: readonly FolderStarChange[],
): StarredPlannerFolder[] {
  const byId = new Map(tasks.map((task) => [folderPageId(task), task]));
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

function folderPageId(task: StarredPlannerFolder): string {
  return isPlannerFolder(task) ? task.page.id : task.id;
}
