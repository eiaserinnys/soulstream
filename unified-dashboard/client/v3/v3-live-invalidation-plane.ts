import { useEffect, useSyncExternalStore } from "react";
import type { SessionStreamEvent } from "@seosoyoung/soul-ui";
import {
  createPageYjsClient,
  destroyPageYjsClientSafely,
} from "@seosoyoung/soul-ui/page";

export type V3InvalidationSource =
  | "session"
  | "catalog"
  | "runbook"
  | "custom_view"
  | "replay"
  | "page"
  | "local";

export interface V3InvalidationSnapshot {
  readonly revision: number;
  readonly sources: Readonly<Record<V3InvalidationSource, number>>;
}

const SOURCE_NAMES: readonly V3InvalidationSource[] = [
  "session",
  "catalog",
  "runbook",
  "custom_view",
  "replay",
  "page",
  "local",
];
const PAGE_INVALIDATION_SETTLE_MS = 250;
const listeners = new Set<() => void>();
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
      invalidateV3("session");
      break;
    case "catalog_updated":
      invalidateV3("catalog");
      break;
    case "runbook_updated":
      invalidateV3("runbook");
      break;
    case "custom_view_updated":
      invalidateV3("custom_view");
      break;
    case "replay_gap":
      invalidateV3("replay");
      break;
    case "session_list":
    case "stream_meta":
      break;
  }
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

export function useV3PageInvalidationSources(pageIds: readonly string[]): void {
  const pageIdKey = trackedV3PageIds(pageIds).join("\0");
  useEffect(() => {
    if (!pageIdKey || typeof window === "undefined") return;
    const clients = pageIdKey.split("\0").map((pageId) => createPageYjsClient({ pageId }));
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleInvalidation = () => {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => invalidateV3("page"), PAGE_INVALIDATION_SETTLE_MS);
    };
    for (const client of clients) {
      client.doc.on("update", scheduleInvalidation);
      void client.connect().catch((error: unknown) => {
        console.warn(`[v3 invalidation] page sync failed: ${client.pageId}`, error);
      });
    }
    return () => {
      if (settleTimer) clearTimeout(settleTimer);
      for (const client of clients) {
        client.doc.off("update", scheduleInvalidation);
        void destroyPageYjsClientSafely(client);
      }
    };
  }, [pageIdKey]);
}

export function resetV3InvalidationForTest(): void {
  snapshot = createSnapshot();
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
