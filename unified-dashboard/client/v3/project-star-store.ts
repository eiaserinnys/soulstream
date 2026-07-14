import { useSyncExternalStore } from "react";
import type { PageDto } from "@seosoyoung/soul-ui/page";

export interface ProjectStarChange {
  page: PageDto;
  starred: boolean;
}

let snapshot: readonly ProjectStarChange[] = [];
const listeners = new Set<() => void>();

export function publishProjectStarChange(change: ProjectStarChange): void {
  snapshot = [
    ...snapshot.filter((candidate) => candidate.page.id !== change.page.id),
    change,
  ];
  for (const listener of listeners) listener();
}

export function useProjectStarChanges(): readonly ProjectStarChange[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function applyProjectStarChanges(
  projects: readonly PageDto[],
  changes: readonly ProjectStarChange[],
): PageDto[] {
  const byId = new Map(projects.map((project) => [project.id, project]));
  for (const change of changes) {
    if (change.starred) byId.set(change.page.id, change.page);
    else byId.delete(change.page.id);
  }
  return [...byId.values()];
}

export function projectStarredState(
  projectId: string,
  changes: readonly ProjectStarChange[],
  initialState = true,
): boolean {
  return changes.find((change) => change.page.id === projectId)?.starred ?? initialState;
}

export function resolveSelectedProject(
  projects: readonly PageDto[],
  changes: readonly ProjectStarChange[],
  projectId: string | null,
): PageDto | null {
  if (!projectId) return null;
  return changes.find((change) => change.page.id === projectId)?.page
    ?? projects.find((project) => project.id === projectId)
    ?? null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): readonly ProjectStarChange[] {
  return snapshot;
}
