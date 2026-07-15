import { useSyncExternalStore } from "react";
import type { PageDto } from "@seosoyoung/soul-ui/page";

export interface TaskStarChange {
  page: PageDto;
  starred: boolean;
}

let snapshot: readonly TaskStarChange[] = [];
const listeners = new Set<() => void>();

export function publishTaskStarChange(change: TaskStarChange): void {
  snapshot = [
    ...snapshot.filter((candidate) => candidate.page.id !== change.page.id),
    change,
  ];
  for (const listener of listeners) listener();
}

export function useTaskStarChanges(): readonly TaskStarChange[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function applyStarredTaskChanges(
  tasks: readonly PageDto[],
  changes: readonly TaskStarChange[],
): PageDto[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const change of changes) {
    if (change.starred) byId.set(change.page.id, change.page);
    else byId.delete(change.page.id);
  }
  return [...byId.values()];
}

export function taskStarredState(
  taskId: string,
  changes: readonly TaskStarChange[],
  initialState = true,
): boolean {
  return changes.find((change) => change.page.id === taskId)?.starred ?? initialState;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): readonly TaskStarChange[] {
  return snapshot;
}
