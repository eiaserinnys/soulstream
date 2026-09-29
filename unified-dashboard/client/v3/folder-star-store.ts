import { useSyncExternalStore } from "react";
import type { PageDto } from "@seosoyoung/soul-ui/page";

export interface FolderStarChange {
  page: PageDto;
  starred: boolean;
}

let snapshot: readonly FolderStarChange[] = [];
const listeners = new Set<() => void>();
const mutationIdsByPage = new Map<string, number>();
let nextMutationId = 0;

export function publishFolderStarChange(change: FolderStarChange): number {
  const mutationId = ++nextMutationId;
  mutationIdsByPage.set(change.page.id, mutationId);
  snapshot = [
    ...snapshot.filter((candidate) => candidate.page.id !== change.page.id),
    change,
  ];
  for (const listener of listeners) listener();
  return mutationId;
}

export function clearFolderStarChange(pageId: string, mutationId: number): void {
  if (mutationIdsByPage.get(pageId) !== mutationId) return;
  mutationIdsByPage.delete(pageId);
  const next = snapshot.filter((candidate) => candidate.page.id !== pageId);
  if (next.length === snapshot.length) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

export function useFolderStarChanges(): readonly FolderStarChange[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function getFolderStarChanges(): readonly FolderStarChange[] {
  return snapshot;
}

export function applyStarredFolderChanges(
  tasks: readonly PageDto[],
  changes: readonly FolderStarChange[],
): PageDto[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const change of changes) {
    if (change.starred) byId.set(change.page.id, change.page);
    else byId.delete(change.page.id);
  }
  return [...byId.values()];
}

export function folderStarredState(
  folderId: string,
  changes: readonly FolderStarChange[],
  initialState = true,
): boolean {
  return changes.find((change) => change.page.id === folderId)?.starred ?? initialState;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): readonly FolderStarChange[] {
  return snapshot;
}

export function resetFolderStarChangesForTest(): void {
  snapshot = [];
  mutationIdsByPage.clear();
  nextMutationId = 0;
}
