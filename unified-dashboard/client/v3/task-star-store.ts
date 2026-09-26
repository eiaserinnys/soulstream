import { useSyncExternalStore } from "react";
import type { PageDto } from "@seosoyoung/soul-ui/page";

export interface TaskStarChange {
  page: PageDto;
  starred: boolean;
}

let snapshot: readonly TaskStarChange[] = [];
const listeners = new Set<() => void>();
const mutationIdsByPage = new Map<string, number>();
let nextMutationId = 0;

export function publishTaskStarChange(change: TaskStarChange): number {
  const mutationId = ++nextMutationId;
  mutationIdsByPage.set(change.page.id, mutationId);
  snapshot = [
    ...snapshot.filter((candidate) => candidate.page.id !== change.page.id),
    change,
  ];
  for (const listener of listeners) listener();
  return mutationId;
}

export function clearTaskStarChange(pageId: string, mutationId: number): void {
  if (mutationIdsByPage.get(pageId) !== mutationId) return;
  mutationIdsByPage.delete(pageId);
  const next = snapshot.filter((candidate) => candidate.page.id !== pageId);
  if (next.length === snapshot.length) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

export function useTaskStarChanges(): readonly TaskStarChange[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function getTaskStarChanges(): readonly TaskStarChange[] {
  return snapshot;
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

export function resetTaskStarChangesForTest(): void {
  snapshot = [];
  mutationIdsByPage.clear();
  nextMutationId = 0;
}
