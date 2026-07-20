import type { TaskStarChange } from "./task-star-store";
import {
  isPlannerTask,
  type StarredPlannerTask,
} from "./planner-data";

export function mergeStarredPlannerTasks(
  first: readonly StarredPlannerTask[],
  second: readonly StarredPlannerTask[],
): StarredPlannerTask[] {
  return [...new Map([...first, ...second].map((task) => [taskPageId(task), task])).values()];
}

export function applyStarredPlannerTaskChanges(
  tasks: readonly StarredPlannerTask[],
  changes: readonly TaskStarChange[],
): StarredPlannerTask[] {
  const byId = new Map(tasks.map((task) => [taskPageId(task), task]));
  for (const change of changes) {
    if (!change.starred) {
      byId.delete(change.page.id);
      continue;
    }
    const current = byId.get(change.page.id);
    byId.set(
      change.page.id,
      current && isPlannerTask(current) ? { ...current, page: change.page } : change.page,
    );
  }
  return [...byId.values()];
}

function taskPageId(task: StarredPlannerTask): string {
  return isPlannerTask(task) ? task.page.id : task.id;
}
