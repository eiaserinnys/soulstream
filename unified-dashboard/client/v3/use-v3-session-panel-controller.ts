import { useCallback, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  useDashboardStore,
  type CatalogState,
  type ChatFocusTarget,
  type SessionSummary,
} from "@seosoyoung/soul-ui";
import type { PageApiClient } from "@seosoyoung/soul-ui/page";

import { loadPlannerFolderById, type PlannerFolder } from "./planner-data";
import type { FolderSectionFocusRequest } from "./FolderSectionNavigation";
import { activateRunSession } from "./folder-workspace-run-model";
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
  resolveSessionFolderWorkspace,
  SessionWorkspaceResolutionError,
} from "./v3-session-workspace";

export function useV3SessionPanelController({
  api,
  catalog,
  currentFolderEntries,
  acknowledgedReviewIds,
  onSelectFolder,
  onClearFolder,
  setChatOpen,
  notify,
}: {
  api: PageApiClient;
  catalog: CatalogState | null;
  currentFolderEntries: readonly PlannerFolder[];
  acknowledgedReviewIds: ReadonlySet<string>;
  onSelectFolder(task: PlannerFolder): Promise<void>;
  onClearFolder(): void;
  setChatOpen: Dispatch<SetStateAction<boolean>>;
  notify(message: string): void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const focusRequestSequence = useRef(0);
  const openRequestSequence = useRef(0);
  const [panelWidth, setPanelWidth] = useState(() => readV3SessionPanelWidth());
  const [focusRequest, setFocusRequest] = useState<FolderSectionFocusRequest | null>(null);
  const [workspaceFolderError, setWorkspaceFolderError] = useState<string | null>(null);
  const setActiveSession = useDashboardStore((state) => state.setActiveSession);
  const setActiveSessionSummary = useDashboardStore((state) => state.setActiveSessionSummary);
  const setActiveTab = useDashboardStore((state) => state.setActiveTab);
  const setFocusEventId = useDashboardStore((state) => state.setFocusEventId);
  const sessions = useMemo(
    () => catalog?.sessionList ?? [],
    [catalog?.sessionList],
  );
  const reviewSessions = useMemo(
    () => sessionPanelGroups(sessions, undefined, acknowledgedReviewIds).review,
    [acknowledgedReviewIds, sessions],
  );

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

  const openSessionForRequest = useCallback(async (
    session: SessionSummary,
    requestSequence: number,
  ): Promise<boolean> => {
    try {
      const resolved = await resolveSessionFolderWorkspace({
        session,
        boardItems: catalog?.boardItems ?? [],
        currentFolderEntries,
        loadFolderById: (folderId) => loadPlannerFolderById(api, folderId),
      });
      if (requestSequence !== openRequestSequence.current) return false;

      activateRunSession(session, { setActiveSessionSummary, setActiveSession, setActiveTab });
      setWorkspaceFolderError(null);
      if (resolved.task) {
        await onSelectFolder(resolved.task);
        focusRequestSequence.current += 1;
        setFocusRequest({
          requestId: focusRequestSequence.current,
          sectionId: "sessions",
          sessionId: session.agentSessionId,
        });
      } else {
        onClearFolder();
        setFocusRequest(null);
      }
      setChatOpen(true);
      return true;
    } catch (error) {
      if (requestSequence !== openRequestSequence.current) return false;
      const message = error instanceof SessionWorkspaceResolutionError
        ? error.message
        : "세션의 업무를 열지 못했습니다.";
      const detail = error instanceof SessionWorkspaceResolutionError && error.cause
        ? errorText(error.cause)
        : errorText(error);
      setWorkspaceFolderError(message);
      notify(`세션의 업무 열기 실패 · ${message} · ${detail}`);
      return false;
    }
  }, [api, catalog?.boardItems, currentFolderEntries, notify, onClearFolder, onSelectFolder, setActiveSession, setActiveSessionSummary, setActiveTab, setChatOpen]);

  const openSession = useCallback(async (session: SessionSummary) => {
    const requestSequence = ++openRequestSequence.current;
    return openSessionForRequest(session, requestSequence);
  }, [openSessionForRequest]);

  const openSessionById = useCallback(async (
    sessionId: string,
    focusEventId: number | null,
    knownSession?: SessionSummary,
    focusTarget?: ChatFocusTarget,
  ) => {
    const requestSequence = ++openRequestSequence.current;
    try {
      const session = await resolveSessionForOpen({
        sessionId,
        knownSession,
        fetchSessions: (options) => orchestratorSessionProvider.fetchSessions(options),
      });
      if (requestSequence !== openRequestSequence.current) return false;
      if (!session) {
        notify("선택한 세션을 찾을 수 없습니다");
        return false;
      }
      const opened = await openSessionForRequest(session, requestSequence);
      if (!opened || requestSequence !== openRequestSequence.current) return false;
      setFocusEventId(focusEventId, sessionId, focusTarget);
      return true;
    } catch (error) {
      if (requestSequence !== openRequestSequence.current) return false;
      notify(`세션 열기 실패 · ${errorText(error)}`);
      return false;
    }
  }, [notify, openSessionForRequest, setFocusEventId]);

  return {
    panelRef,
    panelWidth,
    sessions,
    reviewSessions,
    focusRequest,
    workspaceFolderError,
    resize,
    openSession,
    openSessionById,
    clearFocusRequest,
    acknowledgeFocusRequest,
  };
}
