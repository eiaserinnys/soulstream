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
  resolveSessionTaskWorkspace,
  SessionWorkspaceResolutionError,
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
  const [workspaceTaskError, setWorkspaceTaskError] = useState<string | null>(null);
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
      const resolved = await resolveSessionTaskWorkspace({
        session,
        boardItems: catalog?.boardItems ?? [],
        currentTasks,
        loadTask: (pageId) => loadPlannerTask(api, pageId),
      });
      setWorkspaceTaskError(null);
      if (resolved.task) {
        setSelectedTaskId(resolved.task.page.id);
        setSelectedTaskSnapshot(resolved.task);
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
      const message = error instanceof SessionWorkspaceResolutionError
        ? error.message
        : "세션의 업무를 열지 못했습니다.";
      const detail = error instanceof SessionWorkspaceResolutionError && error.cause
        ? errorText(error.cause)
        : errorText(error);
      setWorkspaceTaskError(message);
      notify(`세션의 업무 열기 실패 · ${message} · ${detail}`);
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
    workspaceTaskError,
    resize,
    openSession,
    openSessionById,
    clearFocusRequest,
    acknowledgeFocusRequest,
  };
}
