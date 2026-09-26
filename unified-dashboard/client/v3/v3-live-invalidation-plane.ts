import { useCallback, useSyncExternalStore } from "react";
import type { SessionStreamEvent } from "@seosoyoung/soul-ui";

export type V3InvalidationSource =
  | "session_created"
  | "session_updated"
  | "session_deleted"
  | "metadata_updated"
  | "catalog"
  | "task"
  | "custom_view"
  | "starred_page"
  | "replay";

export interface V3InvalidationSnapshot {
  readonly revision: number;
  readonly sources: Readonly<Record<V3InvalidationSource, number>>;
}

const SOURCE_NAMES: readonly V3InvalidationSource[] = [
  "session_created",
  "session_updated",
  "session_deleted",
  "metadata_updated",
  "catalog",
  "task",
  "custom_view",
  "starred_page",
  "replay",
];
const listeners = new Set<() => void>();
const pageListeners = new Map<string, Set<() => void>>();
const pageRevisions = new Map<string, number>();
let snapshot = createSnapshot();

export function getV3InvalidationSnapshot(): V3InvalidationSnapshot {
  return snapshot;
}

export function invalidateV3(source: V3InvalidationSource): void {
  snapshot = Object.freeze({
    revision: snapshot.revision + 1,
    sources: Object.freeze({
      ...snapshot.sources,
      [source]: snapshot.sources[source] + 1,
    }),
  });
  for (const listener of listeners) listener();
}

export function acceptV3SessionStreamEvent(event: SessionStreamEvent): void {
  switch (event.type) {
    case "session_created":
    case "session_updated":
    case "session_deleted":
    case "metadata_updated":
      invalidateV3(event.type);
      break;
    case "catalog_updated":
      invalidateV3("catalog");
      break;
    case "task_updated":
      invalidateV3("task");
      break;
    case "custom_view_updated":
      invalidateV3("custom_view");
      break;
    case "page_updated":
      invalidateV3Page(event.page_id);
      invalidateV3("starred_page");
      break;
    case "replay_gap":
      invalidateV3("replay");
      break;
    case "session_list":
    case "stream_meta":
      break;
  }
}

export interface V3PlannerInvalidationKeys {
  readonly daily: number;
  readonly project: number;
  readonly starred: number;
  readonly runHistory: number;
  readonly pageDetail: number;
}

export function selectV3PlannerInvalidationKeys(
  current: V3InvalidationSnapshot,
): V3PlannerInvalidationKeys {
  const pageCollections = selectV3InvalidationKey(current, [
    "session_created",
    "session_deleted",
    "task",
    "replay",
  ]);
  return {
    daily: pageCollections,
    project: pageCollections,
    starred: pageCollections + current.sources.starred_page,
    runHistory: selectV3InvalidationKey(current, [
      "session_created",
      "session_deleted",
      "replay",
    ]),
    pageDetail: selectV3InvalidationKey(current, ["replay"]),
  };
}

export function useV3PlannerInvalidationKeys(): V3PlannerInvalidationKeys {
  const current = useSyncExternalStore(subscribe, getV3InvalidationSnapshot, getV3InvalidationSnapshot);
  return selectV3PlannerInvalidationKeys(current);
}

export function selectV3InvalidationKey(
  current: V3InvalidationSnapshot,
  sources: readonly V3InvalidationSource[],
): number {
  return sources.reduce((total, source) => total + current.sources[source], 0);
}

export function useV3InvalidationKey(sources: readonly V3InvalidationSource[]): number {
  const current = useSyncExternalStore(subscribe, getV3InvalidationSnapshot, getV3InvalidationSnapshot);
  return selectV3InvalidationKey(current, sources);
}

export function trackedV3PageIds(
  pageIds: readonly (string | null | undefined)[],
): string[] {
  return [...new Set(pageIds.filter((pageId): pageId is string => (
    typeof pageId === "string" && pageId.length > 0 && pageId.trim() === pageId
  )))].sort();
}

export function getV3PageInvalidationKey(pageIds: readonly string[]): number {
  return trackedV3PageIds(pageIds).reduce((total, pageId) => (
    total + (pageRevisions.get(pageId) ?? 0)
  ), 0);
}

export function subscribeV3PageInvalidation(
  pageIds: readonly string[],
  listener: () => void,
): () => void {
  const ids = trackedV3PageIds(pageIds);
  for (const pageId of ids) {
    pageRevisions.set(pageId, pageRevisions.get(pageId) ?? 0);
    const pageListenersForId = pageListeners.get(pageId) ?? new Set<() => void>();
    pageListenersForId.add(listener);
    pageListeners.set(pageId, pageListenersForId);
  }
  return () => {
    for (const pageId of ids) {
      const pageListenersForId = pageListeners.get(pageId);
      pageListenersForId?.delete(listener);
      if (pageListenersForId?.size === 0) {
        pageListeners.delete(pageId);
        pageRevisions.delete(pageId);
      }
    }
  };
}

export function invalidateV3Page(pageId: string): void {
  const pageListenersForId = pageListeners.get(pageId);
  if (!pageListenersForId) return;
  pageRevisions.set(pageId, (pageRevisions.get(pageId) ?? 0) + 1);
  for (const listener of pageListenersForId) listener();
}

export function useV3PageInvalidationKey(pageIds: readonly (string | null | undefined)[]): number {
  const pageIdKey = trackedV3PageIds(pageIds).join("\0");
  const stablePageIds = pageIdKey ? pageIdKey.split("\0") : [];
  const subscribePages = useCallback(
    (listener: () => void) => subscribeV3PageInvalidation(stablePageIds, listener),
    [pageIdKey],
  );
  const getSnapshot = useCallback(
    () => getV3PageInvalidationKey(stablePageIds),
    [pageIdKey],
  );
  return useSyncExternalStore(subscribePages, getSnapshot, getSnapshot);
}

export function resetV3InvalidationForTest(): void {
  snapshot = createSnapshot();
  pageListeners.clear();
  pageRevisions.clear();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function createSnapshot(): V3InvalidationSnapshot {
  return Object.freeze({
    revision: 0,
    sources: Object.freeze(Object.fromEntries(
      SOURCE_NAMES.map((source) => [source, 0]),
    ) as Record<V3InvalidationSource, number>),
  });
}
