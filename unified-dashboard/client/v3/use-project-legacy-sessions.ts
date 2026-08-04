import { useCallback, useEffect, useState } from "react";
import type { SessionSummary } from "@seosoyoung/soul-ui";

import {
  loadProjectLegacySessionPage,
  type PlannerDataDependencies,
} from "./planner-data";

export interface ProjectLegacySessionsState {
  projectPageId: string;
  status: "loading" | "ready" | "error";
  items: SessionSummary[];
  nextCursor: string | null;
  message: string | null;
  loadingMore: boolean;
}

export interface ProjectLegacySessionsController {
  state: ProjectLegacySessionsState | null;
  loadMore(): Promise<void>;
}

export function useProjectLegacySessions({
  dependencies,
  projectPageId,
  folderMapped,
  notify,
}: {
  dependencies: PlannerDataDependencies;
  projectPageId: string | null;
  folderMapped: boolean;
  notify(message: string): void;
}): ProjectLegacySessionsController {
  const [state, setState] = useState<ProjectLegacySessionsState | null>(null);

  useEffect(() => {
    if (!projectPageId || !folderMapped) {
      setState(null);
      return;
    }
    let active = true;
    setState({
      projectPageId,
      status: "loading",
      items: [],
      nextCursor: null,
      message: null,
      loadingMore: false,
    });
    void loadProjectLegacySessionPage(dependencies, projectPageId, undefined)
      .then((page) => {
        if (!active) return;
        setState({
          projectPageId,
          status: "ready",
          items: page.items,
          nextCursor: page.nextCursor,
          message: null,
          loadingMore: false,
        });
      })
      .catch((error: unknown) => {
        if (!active) return;
        const message = errorText(error);
        setState({
          projectPageId,
          status: "error",
          items: [],
          nextCursor: null,
          message,
          loadingMore: false,
        });
        notify(`레가시 세션 조회 실패 · ${message}`);
      });
    return () => { active = false; };
  }, [dependencies, folderMapped, notify, projectPageId]);

  const loadMore = useCallback(async () => {
    if (!state?.nextCursor || state.loadingMore) return;
    const current = state;
    setState({ ...current, loadingMore: true });
    try {
      const page = await loadProjectLegacySessionPage(
        dependencies,
        current.projectPageId,
        current.nextCursor ?? undefined,
      );
      setState((latest) => latest?.projectPageId === current.projectPageId
        ? {
            ...latest,
            status: "ready",
            items: mergeSessions(latest.items, page.items),
            nextCursor: page.nextCursor,
            message: null,
            loadingMore: false,
          }
        : latest);
    } catch (error) {
      notify(`레가시 세션 더 보기 실패 · ${errorText(error)}`);
      setState((latest) => latest?.projectPageId === current.projectPageId
        ? { ...latest, loadingMore: false }
        : latest);
    }
  }, [dependencies, notify, state]);

  return { state, loadMore };
}

function mergeSessions(
  current: readonly SessionSummary[],
  incoming: readonly SessionSummary[],
): SessionSummary[] {
  const byId = new Map(current.map((session) => [session.agentSessionId, session]));
  for (const session of incoming) byId.set(session.agentSessionId, session);
  return [...byId.values()];
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
