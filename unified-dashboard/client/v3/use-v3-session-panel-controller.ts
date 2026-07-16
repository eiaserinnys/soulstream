import { useCallback, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  useDashboardStore,
  type CatalogState,
  type SessionSummary,
} from "@seosoyoung/soul-ui";
import type { PageApiClient } from "@seosoyoung/soul-ui/page";

import { loadPlannerTask, type PlannerTask } from "./planner-data";
import { activateRunSession } from "./task-workspace-model";
import { errorText } from "./v3-dashboard-utils";
import { sessionPanelGroups } from "./v3-session-panel-model";
import {
  clampV3SessionPanelWidth,
  readV3SessionPanelWidth,
  writeV3SessionPanelWidth,
} from "./v3-session-panel-width";
import { resolveSessionWorkspace } from "./v3-session-workspace";

export function useV3SessionPanelController({
  api,
  catalog,
  currentTasks,
  acknowledgedReviewIds,
  setSelectedTaskId,
  setSelectedTaskSnapshot,
  setWorkspaceOpen,
  setChatOpen,
  notify,
}: {
  api: PageApiClient;
  catalog: CatalogState | null;
  currentTasks: readonly PlannerTask[];
  acknowledgedReviewIds: ReadonlySet<string>;
  setSelectedTaskId: Dispatch<SetStateAction<string | null>>;
  setSelectedTaskSnapshot: Dispatch<SetStateAction<PlannerTask | null>>;
  setWorkspaceOpen: Dispatch<SetStateAction<boolean>>;
  setChatOpen: Dispatch<SetStateAction<boolean>>;
  notify(message: string): void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const [panelWidth, setPanelWidth] = useState(() => readV3SessionPanelWidth());
  const setActiveSession = useDashboardStore((state) => state.setActiveSession);
  const setActiveSessionSummary = useDashboardStore((state) => state.setActiveSessionSummary);
  const setActiveTab = useDashboardStore((state) => state.setActiveTab);
  const sessions = useMemo(
    () => (catalog?.sessionList ?? []).filter((session) => !acknowledgedReviewIds.has(session.agentSessionId)),
    [acknowledgedReviewIds, catalog?.sessionList],
  );
  const reviewSessions = useMemo(() => sessionPanelGroups(sessions).review, [sessions]);

  const resize = useCallback((deltaPercent: number) => {
    const deltaPx = document.documentElement.clientWidth * deltaPercent / 100;
    setPanelWidth((current) => {
      const next = clampV3SessionPanelWidth(current - deltaPx);
      writeV3SessionPanelWidth(next);
      return next;
    });
  }, []);

  const openSession = useCallback(async (session: SessionSummary) => {
    activateRunSession(session, { setActiveSessionSummary, setActiveSession, setActiveTab });
    try {
      const resolved = await resolveSessionWorkspace({
        session,
        boardItems: catalog?.boardItems ?? [],
      });
      if (resolved.loadedBoardItems && resolved.folderId) {
        useDashboardStore.getState().setBoardItemsForFolder(
          resolved.folderId,
          resolved.loadedBoardItems,
        );
      }
      if (resolved.target.kind === "task") {
        const { pageId } = resolved.target;
        const loaded = currentTasks.find((task) => (
          task.page.id === pageId || task.runbookId === pageId
        )) ?? await loadPlannerTask(api, pageId);
        setSelectedTaskId(loaded.page.id);
        setSelectedTaskSnapshot(loaded);
      } else {
        setSelectedTaskId(null);
        setSelectedTaskSnapshot(null);
      }
    } catch (error) {
      setSelectedTaskId(null);
      setSelectedTaskSnapshot(null);
      notify(`세션의 업무 열기 실패 · ${errorText(error)}`);
    }
    setWorkspaceOpen(true);
    setChatOpen(true);
  }, [api, catalog?.boardItems, currentTasks, notify, setActiveSession, setActiveSessionSummary, setActiveTab, setChatOpen, setSelectedTaskId, setSelectedTaskSnapshot, setWorkspaceOpen]);

  return { panelRef, panelWidth, sessions, reviewSessions, resize, openSession };
}
