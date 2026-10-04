import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionSummary } from "@seosoyoung/soul-ui";

import { loadFolderSessionPage, type PlannerDataDependencies, type PlannerPage } from "./planner-data";

interface FolderSessionsState {
  folderId: string;
  items: SessionSummary[];
  nextCursor: string | null;
  loadingMore: boolean;
  loadFailed: boolean;
  hasLoadedMore: boolean;
}

export function useFolderSessions({ dependencies, folderId, initial, notify }: {
  dependencies: PlannerDataDependencies;
  folderId: string | null;
  initial: PlannerPage<SessionSummary> | null;
  notify(message: string): void;
}) {
  const [state, setState] = useState<FolderSessionsState | null>(() => folderId && initial
    ? { folderId, items: initial.items, nextCursor: initial.nextCursor, loadingMore: false, loadFailed: false, hasLoadedMore: false }
    : null);
  const inFlightFolderRef = useRef<string | null>(null);

  useEffect(() => {
    if (!folderId || !initial) {
      setState(null);
      return;
    }
    setState(current => current?.folderId === folderId ? {
      ...current,
      items: mergeSessions(initial.items, current.items.filter(session =>
        !initial.items.some(item => item.agentSessionId === session.agentSessionId))),
      nextCursor: current.hasLoadedMore ? current.nextCursor : initial.nextCursor,
    } : { folderId, items: initial.items, nextCursor: initial.nextCursor, loadingMore: false, loadFailed: false, hasLoadedMore: false });
  }, [folderId, initial]);

  const loadMore = useCallback(async () => {
    if (!state?.nextCursor || state.folderId !== folderId || state.loadingMore
      || inFlightFolderRef.current === state.folderId) return;
    const current = state;
    inFlightFolderRef.current = current.folderId;
    setState({ ...current, loadingMore: true, loadFailed: false });
    try {
      const page = await loadFolderSessionPage(dependencies, current.folderId, current.nextCursor ?? undefined);
      setState((latest) => latest?.folderId === current.folderId ? {
        ...latest,
        items: mergeSessions(latest.items, page.items),
        nextCursor: page.nextCursor,
        loadingMore: false,
        loadFailed: false,
        hasLoadedMore: true,
      } : latest);
    } catch (error) {
      notify(`세션 더 보기 실패 · ${errorText(error)}`);
      setState((latest) => latest?.folderId === current.folderId
        ? { ...latest, loadingMore: false, loadFailed: true } : latest);
    } finally {
      if (inFlightFolderRef.current === current.folderId) inFlightFolderRef.current = null;
    }
  }, [dependencies, folderId, notify, state]);

  const removeSessions = useCallback((sessionIds: readonly string[]) => {
    const removed = new Set(sessionIds);
    setState((current) => current ? {
      ...current,
      items: current.items.filter((session) => !removed.has(session.agentSessionId)),
    } : current);
  }, []);

  const moveSession = useCallback((sessionId: string, targetFolderId: string) => {
    setState((current) => current && current.folderId !== targetFolderId ? {
      ...current,
      items: current.items.filter((session) => session.agentSessionId !== sessionId),
    } : current);
  }, []);

  return { state, loadMore, removeSessions, moveSession };
}

function mergeSessions(current: readonly SessionSummary[], incoming: readonly SessionSummary[]): SessionSummary[] {
  const byId = new Map(current.map((session) => [session.agentSessionId, session]));
  for (const session of incoming) byId.set(session.agentSessionId, session);
  return [...byId.values()];
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
