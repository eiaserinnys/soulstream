import { useCallback, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  useDashboardStore,
  type CatalogState,
  type SessionSummary,
} from "@seosoyoung/soul-ui";
import type { PageApiClient } from "@seosoyoung/soul-ui/page";

import { loadPlannerTask, type PlannerTask } from "./planner-data";
import type { TaskSectionFocusRequest } from "./TaskSectionNavigation";
import { activateRunSession } from "./task-workspace-model";
import { errorText } from "./v3-dashboard-utils";
import { sessionPanelGroups } from "./v3-session-panel-model";
import {
  clampV3SessionPanelWidth,
  readV3SessionPanelWidth,
  writeV3SessionPanelWidth,
} from "./v3-session-panel-width";
import { orchestratorSessionProvider } from "../providers";
import {
  resolveSessionForOpen,
  resolveSessionWorkspace,
} from "./v3-session-workspace";

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
  const focusRequestSequence = useRef(0);
  const [panelWidth, setPanelWidth] = useState(() => readV3SessionPanelWidth());
  const [focusRequest, setFocusRequest] = useState<TaskSectionFocusRequest | null>(null);
  const setActiveSession = useDashboardStore((state) => state.setActiveSession);
  const setActiveSessionSummary = useDashboardStore((state) => state.setActiveSessionSummary);
  const setActiveTab = useDashboardStore((state) => state.setActiveTab);
  const setFocusEventId = useDashboardStore((state) => state.setFocusEventId);
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
  const clearFocusRequest = useCallback(() => setFocusRequest(null), []);
  const acknowledgeFocusRequest = useCallback((requestId: number) => {
    setFocusRequest((current) => current?.requestId === requestId ? null : current);
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
          task.page.id === pageId || task.taskId === pageId
        )) ?? await loadPlannerTask(api, pageId);
        setSelectedTaskId(loaded.page.id);
        setSelectedTaskSnapshot(loaded);
        focusRequestSequence.current += 1;
        setFocusRequest({
          requestId: focusRequestSequence.current,
          sectionId: "sessions",
          sessionId: session.agentSessionId,
        });
      } else {
        setSelectedTaskId(null);
        setSelectedTaskSnapshot(null);
        setFocusRequest(null);
      }
    } catch (error) {
      setSelectedTaskId(null);
      setSelectedTaskSnapshot(null);
      setFocusRequest(null);
      notify(`세션의 업무 열기 실패 · ${errorText(error)}`);
    }
    setWorkspaceOpen(true);
    setChatOpen(true);
  }, [api, catalog?.boardItems, currentTasks, notify, setActiveSession, setActiveSessionSummary, setActiveTab, setChatOpen, setSelectedTaskId, setSelectedTaskSnapshot, setWorkspaceOpen]);

  const openSessionById = useCallback(async (
    sessionId: string,
    focusEventId: number,
    knownSession?: SessionSummary,
  ) => {
    try {
      const session = await resolveSessionForOpen({
        sessionId,
        knownSession,
        fetchSessions: (options) => orchestratorSessionProvider.fetchSessions(options),
      });
      if (!session) {
        notify("선택한 세션을 찾을 수 없습니다");
        return;
      }
      await openSession(session);
      setFocusEventId(focusEventId);
    } catch (error) {
      notify(`세션 열기 실패 · ${errorText(error)}`);
    }
  }, [notify, openSession, setFocusEventId]);

  return {
    panelRef,
    panelWidth,
    sessions,
    reviewSessions,
    focusRequest,
    resize,
    openSession,
    openSessionById,
    clearFocusRequest,
    acknowledgeFocusRequest,
  };
}
