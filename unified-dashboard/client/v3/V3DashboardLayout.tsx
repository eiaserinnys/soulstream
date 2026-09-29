import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AskQuestionBanner, DragHandle, LiquidGlassCanvas, LiquidGlassProvider, WallpaperLayer, fetchFolderSnapshot, initTheme, useAuth, useDashboardStore, useInitialCatalogLoad, useNotification, useReadPositionSync, useSessionProvider, useGlassSurface, useUserPreferencesSync, type BoardContainerRef, type SessionSummary } from "@seosoyoung/soul-ui";
import { clampDashboardLeftSidebarWidth, writeDashboardLeftSidebarWidth } from "@seosoyoung/soul-ui/components/dashboard-sidebar-collapse";
import { createPageApiClient } from "@seosoyoung/soul-ui/page";
import { V3_CARD_GAP_PX, V3_CONTENT_MAX_WIDTH_PX, V3_NAVIGATION_DEFAULT_WIDTH_PX, V3_OUTER_INSET_PX, V3_PANEL_GAP_PX, readV3NavigationWidth } from "./v3-layout-metrics";
import { useNodes } from "../hooks/useNodes";
import { ConfigModal } from "../components/ConfigModal";
import { V3SearchModal } from "./V3SearchModal";
import { orchestratorSessionProvider } from "../providers";
import { NewTaskForm } from "./NewTaskForm";
import { DailyPlannerView } from "./PlannerViews";
import { MobilePlannerTabs, useMobilePlannerMode } from "./MobilePlannerTabs";
import { MobileProjectList } from "./MobileProjectList";
import { RitualModal } from "./RitualModal";
import { TaskWorkspace } from "./TaskWorkspace";
import { FolderWorkspaceSections } from "./FolderWorkspaceSections";
import { useFolderWorkspaceFolder } from "./use-folder-workspace-task";
import { setFolderChecklistEnabled } from "./folder-workspace-api";
import { TaskProjectMoveDialog } from "./TaskProjectMoveDialog";
import { V3Navigation } from "./V3Navigation";
import { V3SessionPanel } from "./V3SessionPanel";
import { V3StandaloneDocumentInspector } from "./V3StandaloneDocumentInspector";
import { V3GlobalToolbar } from "./V3GlobalToolbar";
import { V3Toast } from "./V3Toast";
import { useV3PlannerActions } from "./use-v3-planner-actions";
import { useV3Notifications } from "./use-v3-notifications";
import { reduceMobilePlannerEscape, revealAttentionDetail, selectMobilePlannerTab, type MobilePlannerState, type MobilePlannerTab } from "./mobile-planner-state";
import { BrowserPlannerMutationPort } from "./planner-browser-port";
import { useFolderStarChanges } from "./task-star-store";
import { createPlannerDataDependencies, starredFolderPage, type PlannerFolder } from "./planner-data";
import { fetchPageSessionDefaults, type PageSessionDefaults } from "./task-workspace-api";
import { activateRunSession, resolveRunSessions } from "./task-workspace-model";
import { buildMobileTaskOptions, errorText, recentDates } from "./v3-dashboard-utils";
import { usePlannerCollections } from "./use-v3-planner-reads";
import { useProjectFolderController } from "./use-project-folder-controller";
import { useV3PageInvalidationKey, useV3PlannerInvalidationKeys } from "./v3-live-invalidation-plane";
import { useFolderParentMoveController } from "./use-task-project-move-controller";
import {
  parseSessionSearchIntent,
  removeSessionSearchIntent,
} from "@soulstream/search-contract";
import { useV3LiveDataPlane } from "./use-v3-live-data-plane";
import { useV3DashboardMutations } from "./use-v3-dashboard-mutations";
import { useV3MutationProjection } from "./use-v3-mutation-projection";
import { useV3SessionPanelController } from "./use-v3-session-panel-controller";
import { useSessionNodeConnectivity } from "./use-session-node-connectivity";
import { useProjectNavigationMutations } from "./use-project-navigation-mutations";
import { useFolderSessions } from "./use-folder-sessions";
import { useTodayDate } from "./use-today-date";
import "./v3-dashboard-styles";
export function V3DashboardLayout() {
  return <LiquidGlassProvider renderDefaultCanvas={false}><V3DashboardContent /></LiquidGlassProvider>;
}
function V3DashboardContent() {
  const today = useTodayDate();
  const dates = useMemo(() => recentDates(today), [today]);
  const api = useMemo(() => createPageApiClient(), []);
  const dataDependencies = useMemo(() => createPlannerDataDependencies(), []);
  const mutationPort = useMemo(() => new BrowserPlannerMutationPort(api), [api]);
  const [selectedDate, setSelectedDate] = useState(today);
  const selectedDateFollowsToday = useRef(true);
  const projectSelection = useProjectFolderController();
  const { resolution, selectedFolderId, selectedProject, clearProject } = projectSelection;
  const workspaceOpen = selectedFolderId !== null;
  const selectedProjectId = selectedProject?.id ?? null;
  const plannerInvalidationKeys = useV3PlannerInvalidationKeys();
  const projectContextInvalidationKey = useV3PageInvalidationKey([selectedProjectId]) + plannerInvalidationKeys.pageDetail;
  const [createOpen, setCreateOpen] = useState(false);
  const [ritualOpen, setRitualOpen] = useState(false);
  const [documentInspectorOpen, setDocumentInspectorOpen] = useState(false);
  const [standaloneDocumentId, setStandaloneDocumentId] = useState<string | null>(null);
  const [standaloneDocumentContainer, setStandaloneDocumentContainer] = useState<BoardContainerRef | null>(null);
  const [acknowledgedReviewIds, setAcknowledgedReviewIds] = useState<ReadonlySet<string>>(() => new Set());
  const [configOpen, setConfigOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [mobileTab, setMobileTab] = useState<MobilePlannerTab>("today");
  const [createPending, setCreatePending] = useState(false);
  const [selectedFolderSnapshot, setSelectedFolderSnapshot] = useState<PlannerFolder | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [detailChatVisible, setDetailChatVisible] = useState(false);
  const [newDocumentOpen, setNewDocumentOpen] = useState(false);
  const [newDocumentTitle, setNewDocumentTitle] = useState("");
  const [sessionDefaults, setSessionDefaults] = useState<PageSessionDefaults | null>(null);
  const [navigationWidth, setNavigationWidth] = useState(() => readV3NavigationWidth());
  const plannerSurfaceRef = useRef<HTMLDivElement>(null);
  const plannerWebglActive = useGlassSurface(plannerSurfaceRef, { enabled: true });
  const resizeNavigation = useCallback((deltaPercent: number) => {
    const deltaPx = document.documentElement.clientWidth * deltaPercent / 100;
    setNavigationWidth((current) => {
      const next = clampDashboardLeftSidebarWidth(current + deltaPx);
      writeDashboardLeftSidebarWidth(next);
      return next;
    });
  }, []);
  useEffect(() => { initTheme(); }, []);
  useEffect(() => {
    if (selectedDateFollowsToday.current) setSelectedDate(today);
  }, [today]);
  const { user, refreshAuthStatus, isLoading: authLoading, isAuthenticated } = useAuth();
  const handleStreamConnectionError = useCallback(() => {
    void refreshAuthStatus().catch(() => undefined);
  }, [refreshAuthStatus]);
  const { toast, notify, notifyWriteFailure } = useV3Notifications(refreshAuthStatus);
  useUserPreferencesSync(user?.email ?? null);
  const catalogLoadState = useInitialCatalogLoad(true);
  const catalogLoadError = catalogLoadState.status === "authentication"
    || catalogLoadState.status === "forbidden"
    || catalogLoadState.status === "error"
    ? "목록 불러오기 실패"
    : null;
  useReadPositionSync();
  useNotification(true);
  useNodes(handleStreamConnectionError);
  const mobileMode = useMobilePlannerMode();
  const catalog = useDashboardStore((state) => state.catalog);
  const catalogSessions = catalog?.sessionList ?? [];
  useEffect(() => {
    setAcknowledgedReviewIds((current) => {
      let next: Set<string> | null = null;
      for (const sessionId of current) {
        const session = catalogSessions.find((candidate) => candidate.agentSessionId === sessionId);
        if (!session || session.status !== "completed" || session.reviewState !== "needs_review") {
          next ??= new Set(current);
          next.delete(sessionId);
        }
      }
      return next ?? current;
    });
  }, [catalogSessions]);
  const activeSessionKey = useDashboardStore((state) => state.activeSessionKey);
  const activeSessionSummary = useDashboardStore((state) => state.activeSessionSummary);
  const setActiveSession = useDashboardStore((state) => state.setActiveSession);
  const setActiveSessionSummary = useDashboardStore((state) => state.setActiveSessionSummary);
  const setActiveTab = useDashboardStore((state) => state.setActiveTab);
  const { nodes, nodeConnectivity } = useSessionNodeConnectivity();
  const folderStarChanges = useFolderStarChanges();
  const {
    daily,
    todayFolderIds,
    setTaskTodayPresence,
    addTaskToToday,
    project,
    projects,
    starredFolders,
    starredFoldersHasMore,
    starredFoldersLoading,
    starredFoldersLoadingMore,
    starredFoldersReordering,
    projectDocumentsLoadingMore,
    subfoldersLoadingMore,
    loadMoreStarredFolders,
    reorderStarredFolders,
    loadMoreProjectDocuments,
    loadMoreSubfolders,
    patchTask: patchLoadedTask,
    removeSessions: removeLoadedSessions,
    moveSession: moveLoadedSession,
    moveTaskProject: moveLoadedTaskProject,
    refreshDaily,
    refreshProject,
    refreshTask,
  } = usePlannerCollections({
    api,
    dependencies: dataDependencies,
    selectedDate,
    today,
    selectedProject,
    selectedFolderId,
    folderStarChanges,
    refreshKeys: plannerInvalidationKeys,
    notify,
  });
  const folderAggregate = project.data?.folder.id === selectedFolderId ? project.data : null;
  const folderSessions = useFolderSessions({
    dependencies: dataDependencies,
    folderId: selectedFolderId,
    initial: folderAggregate?.sessions ?? null,
    notify,
  });
  const currentTasks = useMemo(
    () => [
      ...(daily.data?.tasks ?? []),
      ...(selectedProject ? (project.data?.tasks ?? []) : []),
    ],
    [daily.data?.tasks, project.data?.tasks, selectedProject],
  );
  const selectedFolder = catalog?.folders.find((folder) => folder.id === selectedFolderId) ?? null;
  const childFolders = useMemo(() => (catalog?.folders ?? []).filter(
    (folder) => !folder.archived && folder.parentFolderId === selectedFolderId,
  ), [catalog?.folders, selectedFolderId]);
  const knownWorkspaceTask = currentTasks.find((task) => task.folderId === selectedFolderId)
    ?? (selectedFolderSnapshot?.folderId === selectedFolderId ? selectedFolderSnapshot : null);
  const folderWorkspace = useFolderWorkspaceFolder({
    folder: selectedFolder,
    aggregate: folderAggregate,
    knownFolder: knownWorkspaceTask,
  });
  const selectedTask = folderWorkspace.folder;
  const selectFolder = useCallback(async (folder: typeof selectedFolder, task?: PlannerFolder) => {
    if (!folder) return;
    setSelectedFolderSnapshot(task ?? null);
    await projectSelection.openFolder(api, folder, projects, notify);
    setNewDocumentOpen(false);
    if (mobileMode) setMobileTab("task");
  }, [api, mobileMode, notify, projectSelection.openFolder, projects]);
  const sessionPanel = useV3SessionPanelController({
    api,
    catalog,
    currentTasks,
    acknowledgedReviewIds,
    onSelectTask: async (task) => {
      const known = catalog?.folders.find((folder) => folder.id === task.folderId);
      const snapshot = known ? null : await fetchFolderSnapshot(task.folderId);
      const folder = known ?? (snapshot ? { ...snapshot.folder, sortOrder: 0 } : null);
      if (!folder) throw new Error("세션의 폴더를 찾을 수 없습니다");
      await selectFolder(folder, task);
    },
    onClearFolder: clearProject,
    setChatOpen,
    notify,
  });
  const attemptedSessionIntent = useRef<string | null>(null);
  useEffect(() => {
    const currentUrl = new URL(window.location.href);
    const hasQueryIntent = currentUrl.searchParams.has("session");
    const hasLegacyIntent = /^#\/feed\//.test(currentUrl.hash);
    if (!hasQueryIntent && !hasLegacyIntent) {
      attemptedSessionIntent.current = null;
      return;
    }
    if (authLoading || !isAuthenticated) return;

    const identity = currentUrl.toString();
    if (attemptedSessionIntent.current === identity) return;
    attemptedSessionIntent.current = identity;

    const intent = parseSessionSearchIntent(currentUrl);
    if (!intent) {
      notify("세션 링크 형식이 잘못되었습니다. URL을 확인한 뒤 다시 시도하세요.");
      return;
    }
    let focusEventId: number | null = null;
    if (intent.eventId !== undefined) {
      if (!/^\d+$/.test(intent.eventId) || Number(intent.eventId) < 1
        || !Number.isSafeInteger(Number(intent.eventId))) {
        notify("세션 링크의 이벤트 ID가 잘못되었습니다. URL을 확인한 뒤 다시 시도하세요.");
        return;
      }
      focusEventId = Number(intent.eventId);
    }

    void sessionPanel.openSessionById(intent.sessionId, focusEventId).then((opened) => {
      if (opened !== true || window.location.href !== identity) return;
      window.history.replaceState(
        window.history.state,
        "",
        removeSessionSearchIntent(window.location.href),
      );
      attemptedSessionIntent.current = null;
    });
  }, [authLoading, isAuthenticated, notify, sessionPanel.openSessionById]);
  const clearSessionPanelFocus = sessionPanel.clearFocusRequest;
  const removeRunHistorySessions = folderSessions.removeSessions;
  const moveRunHistorySession = folderSessions.moveSession;
  const { patchPlannerFolder, removeSessionsFromPlanner, moveSessionInPlanner, moveTaskProjectInPlanner } = useV3MutationProjection({
    patchLoadedTask, removeLoadedSessions, moveLoadedSession, moveLoadedTaskProject, removeRunHistorySessions, moveRunHistorySession, setSelectedFolderSnapshot,
  });
  const plannerActions = useV3PlannerActions({
    api,
    folders: catalog?.folders ?? [],
    notify,
    notifyWriteFailure,
    todayFolderIds,
    setTaskTodayPresence,
    addTaskToToday,
    patchTask: patchPlannerFolder,
    removeSessionsFromPlanner,
    moveSessionInPlanner,
    moveTaskProjectInPlanner,
    refreshTask,
  });
  const taskProjectMove = useFolderParentMoveController({
    api,
    folders: catalog?.folders ?? [],
    moveTask: plannerActions.moveTaskProject,
    notify,
  });
  const projectNavigationMutations = useProjectNavigationMutations({
    api,
    knownPages: projects,
    notify,
    selectedFolderId,
    createProject: projectSelection.createProject,
    patchProjectTitle: projectSelection.patchProjectTitle,
    clearProject,
  });
  const plannerSessionIds = useMemo(
    () => [...new Set([
      ...currentTasks.flatMap((task) => task.sessionIds),
      ...(daily.data?.reviewSessionIds ?? []),
      ...(folderSessions.state?.items.map((session) => session.agentSessionId) ?? []),
    ])].sort(),
    [currentTasks, daily.data?.reviewSessionIds, folderSessions.state?.items],
  );
  const {
    sessions: targetedRunSessions,
    loading: targetedRunSessionsLoading,
  } = useV3LiveDataPlane({
    sessionIds: plannerSessionIds,
    onConnectionError: handleStreamConnectionError,
  });
  const runSessionResolution = useMemo(() => resolveRunSessions({
    sessionIds: plannerSessionIds,
    catalogSessions,
    targetedSessions: targetedRunSessions,
    targetedLoading: targetedRunSessionsLoading,
  }), [catalogSessions, plannerSessionIds, targetedRunSessions, targetedRunSessionsLoading]);
  const sessions = runSessionResolution.sessions;
  const cursorScope = `${window.location.origin}|${user?.email ?? "anonymous"}`;
  const detailActive = workspaceOpen && detailChatVisible;
  const {
    synchronizedSessionKey,
    status: sessionConnectionStatus,
    reconnect: reconnectSession,
  } = useSessionProvider({
    sessionKey: activeSessionKey,
    getSessionProvider: () => orchestratorSessionProvider,
    active: detailActive,
    cursorScope,
    onConnectionError: handleStreamConnectionError,
  });
  const historyEnabled = detailActive && synchronizedSessionKey === activeSessionKey;
  const mobileTaskOptions = useMemo(
    () => buildMobileTaskOptions(catalog?.folders ?? [], sessions),
    [catalog?.folders, sessions],
  );
  useEffect(() => {
    if (!selectedProjectId) {
      setSessionDefaults(null);
      return;
    }
    let active = true;
    void fetchPageSessionDefaults(selectedProjectId).then((defaults) => {
      if (active) setSessionDefaults(defaults);
    }).catch((error: unknown) => {
      if (active) notify(`실행 기본값 조회 실패 · ${errorText(error)}`);
    });
    return () => { active = false; };
  }, [notify, selectedProjectId]);
  const activeSession = catalogSessions.find((session) => session.agentSessionId === activeSessionKey)
    ?? sessions.find((session) => session.agentSessionId === activeSessionKey)
    ?? (activeSessionSummary?.agentSessionId === activeSessionKey ? activeSessionSummary : undefined);
  const chatInputDisabled = activeSessionKey !== null && (
    !activeSession?.nodeId || nodes.get(activeSession.nodeId)?.status !== "connected"
  );
  const fileUploadUrl = activeSession?.nodeId && !chatInputDisabled
    ? `/api/attachments/sessions?nodeId=${encodeURIComponent(activeSession.nodeId)}`
    : undefined;
  const applyMobileState = useCallback((next: MobilePlannerState) => {
    setMobileTab(next.activeTab);
    setChatOpen(next.chatOpen);
    if (!next.workspaceOpen) clearProject();
    else if (next.selectedFolderId !== selectedFolderId) {
      const folder = catalog?.folders.find((candidate) => candidate.id === next.selectedFolderId) ?? null;
      if (folder) void selectFolder(folder);
    }
    if (next.selectedRunId !== activeSessionKey) {
      const session = sessions.find((candidate) => candidate.agentSessionId === next.selectedRunId) ?? null;
      if (session) {
        activateRunSession(session, { setActiveSessionSummary, setActiveSession, setActiveTab });
      } else {
        setActiveSessionSummary(null);
        setActiveSession(null);
      }
    }
    if (next.activeTab === "today") {
      clearProject();
      selectedDateFollowsToday.current = true;
      setSelectedDate(today);
    }
  }, [activeSessionKey, catalog?.folders, clearProject, selectFolder, selectedFolderId, sessions, setActiveSession, setActiveSessionSummary, setActiveTab, today]);
  const switchMobileTab = useCallback((target: MobilePlannerTab) => {
    applyMobileState(selectMobilePlannerTab({
      activeTab: mobileTab,
      selectedFolderId: selectedFolderId,
      selectedRunId: activeSessionKey,
      workspaceOpen,
      chatOpen,
    }, target, mobileTaskOptions));
  }, [activeSessionKey, applyMobileState, chatOpen, mobileTab, mobileTaskOptions, selectedFolderId, workspaceOpen]);
  const returnToPlanner = useCallback(() => {
    setMobileTab("today");
    setChatOpen(false);
    clearProject();
    selectedDateFollowsToday.current = true;
    setSelectedDate(today);
  }, [clearProject, today]);
  const closeWorkspace = useCallback(() => {
    setMobileTab("today");
    setChatOpen(false);
    clearProject();
  }, [clearProject]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const typing = target?.matches("input, textarea, select, [contenteditable=true]") ?? false;
      if ((event.key === "c" || event.key === "C") && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        setCreateOpen(true);
        return;
      }
      if (event.key !== "Escape") return;
      if (createOpen) setCreateOpen(false);
      else if (newDocumentOpen) setNewDocumentOpen(false);
      else if (mobileMode && mobileTab === "chat" && chatOpen) {
        event.preventDefault();
        applyMobileState(reduceMobilePlannerEscape({
          activeTab: mobileTab,
          selectedFolderId: selectedFolderId,
          selectedRunId: activeSessionKey,
          workspaceOpen,
          chatOpen,
        }));
      }
      else if (workspaceOpen) closeWorkspace();
      else if (selectedProjectId) clearProject();
      else if (selectedDate !== today) {
        selectedDateFollowsToday.current = true;
        setSelectedDate(today);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeSessionKey, applyMobileState, chatOpen, clearProject, closeWorkspace, createOpen, mobileMode, mobileTab, newDocumentOpen, selectedDate, selectedFolderId, selectedProjectId, today, workspaceOpen]);
  const openTask = (task: PlannerFolder) => {
    clearSessionPanelFocus();
    setActiveSessionSummary(null);
    setActiveSession(null);
    void selectFolder(catalog?.folders.find((folder) => folder.id === task.folderId) ?? null, task);
    setChatOpen(!mobileMode);
    if (mobileMode) setMobileTab("task");
  };
  const openStarredFolder = async (page: typeof starredFolders[number]) => {
    const targetPage = starredFolderPage(page);
    const folder = catalog?.folders.find((candidate) => candidate.projectPageId === targetPage.id) ?? null;
    if (!folder) {
      notify("별표 폴더를 찾을 수 없습니다.");
      return;
    }
    await selectFolder(folder, "page" in page ? page : undefined);
  };
  const openSession = useCallback((session: SessionSummary) => {
    clearSessionPanelFocus();
    activateRunSession(session, { setActiveSessionSummary, setActiveSession, setActiveTab });
    setChatOpen(true);
    if (mobileMode && selectedFolderId) setMobileTab("chat");
  }, [clearSessionPanelFocus, mobileMode, selectedFolderId, setActiveSession, setActiveSessionSummary, setActiveTab]);
  const openProjectDocument = useCallback((documentId: string) => {
    setStandaloneDocumentId(documentId);
    setStandaloneDocumentContainer(selectedFolderId ? { kind: "folder", id: selectedFolderId } : null);
    setDocumentInspectorOpen(true);
  }, [selectedFolderId]);
  const {
    createTask,
    saveMemo,
    createDocument,
    saveDescription,
    acknowledgeReview,
    applyTaskBlocks,
    applyRitualAction,
  } = useV3DashboardMutations({
    api,
    mutationPort,
    catalog,
    projects,
    selectedDate,
    today,
    daily,
    selectedProject,
    selectedTask,
    selectedPageId: selectedProjectId,
    setCreateOpen,
    setCreatePending,
    clearProject,
    setSelectedDate,
    newDocumentTitle,
    setNewDocumentTitle,
    setNewDocumentOpen,
    setAcknowledgedReviewIds,
    notify,
    notifyWriteFailure,
    patchPlannerFolder,
    addTaskToToday,
    refreshDaily,
    refreshProject,
    refreshTask,
  });
  const { sessions: panelSessions, reviewSessions } = sessionPanel;
  const selectedFolderName = selectedFolder?.name ?? "폴더";
  const shellStyle = {
    "--v3-card-gap": `${V3_CARD_GAP_PX}px`,
    "--v3-panel-gap": `${V3_PANEL_GAP_PX}px`,
    "--v3-outer-inset": `${V3_OUTER_INSET_PX}px`,
    "--v3-content-max-width": `${V3_CONTENT_MAX_WIDTH_PX}px`,
    "--v3-navigation-width": `${navigationWidth || V3_NAVIGATION_DEFAULT_WIDTH_PX}px`,
    "--v3-session-panel-width": `${sessionPanel.panelWidth}px`,
  } as CSSProperties;
  const workspaceTask = useMemo(
    () => selectedTask ? {
      ...selectedTask,
      sessionIds: [...new Set([
        ...(folderSessions.state?.items.map((session) => session.agentSessionId) ?? []),
      ])],
    } : null,
    [folderSessions.state?.items, selectedTask],
  );
  const parentFolder = catalog?.folders.find((folder) => folder.id === selectedFolder?.parentFolderId) ?? null;
  const projectTitle = parentFolder?.name ?? "미분류";
  const projectFolderId = selectedFolderId;
  return (
    <div className="v3-shell isolate font-sans" data-mobile-tab={mobileTab} data-mobile-project-open={selectedFolderId ? "true" : "false"} style={shellStyle}>
      <WallpaperLayer />
      <LiquidGlassCanvas />
      <V3GlobalToolbar
        onOpenConfig={() => setConfigOpen(true)}
        onOpenSearch={() => setSearchOpen(true)}
      />
      <V3Navigation
        dates={dates} selectedDate={selectedDate} folders={catalog?.folders ?? []} catalogLoadError={catalogLoadError} selectedFolderId={selectedFolderId}
        starredFolders={starredFolders} starredFoldersHasMore={starredFoldersHasMore} starredFoldersLoading={starredFoldersLoading || starredFoldersLoadingMore || starredFoldersReordering} todayFolderIds={todayFolderIds}
        completedFolderIds={new Set(currentTasks.filter((task) => task.status === "completed").map((task) => task.page.id))}
        onLoadMoreStarredFolders={() => { void loadMoreStarredFolders(); }}
        onReorderStarredFolders={reorderStarredFolders}
        onSelectDate={(date) => { clearProject(); selectedDateFollowsToday.current = date === today; setSelectedDate(date); }} onSelectFolder={(folder) => { void selectFolder(folder); }}
        onSelectTask={(task) => { void openStarredFolder(task); }} onCompleteTask={plannerActions.completeStarredFolder} onToggleTaskToday={plannerActions.toggleStarredFolderToday}
        onMoveTaskToProject={(task) => { void taskProjectMove.openPage(task); }} {...projectNavigationMutations}
        onCreateTask={(folderId) => {
          void selectFolder(catalog?.folders.find((folder) => folder.id === folderId) ?? null);
          setCreateOpen(true);
        }}
      />
      {mobileMode && mobileTab === "projects" && !selectedFolderId ? <MobileProjectList folders={catalog?.folders ?? []} onSelect={(folder) => { void selectFolder(folder); }} /> : null}
      <div className="v3-navigation-resize" data-testid="v3-navigation-resize-handle" aria-hidden="true">
        <DragHandle onDrag={resizeNavigation} widthPx={V3_PANEL_GAP_PX} />
      </div>
      <main className="v3-main">
        <div
          ref={plannerSurfaceRef}
          className="v3-planner border border-glass-border glass-strong glass-chrome lg-rim"
          data-liquid-glass-webgl={plannerWebglActive ? "true" : undefined}
        >
          <div className="v3-planner-scroll" data-testid="v3-planner-scroll">
            {createOpen ? <NewTaskForm folders={catalog?.folders ?? []} invalidationKey={projectContextInvalidationKey} initialFolderId={selectedFolderId} pending={createPending} onCreate={createTask} onCancel={() => setCreateOpen(false)} /> : null}
            {selectedFolderId ? (!workspaceTask && !activeSession ? (
              <section className="v3-load-error" aria-busy={resolution.status === "loading"}>
                <h1>{selectedFolderName}</h1>
                {resolution.status === "error" || project.status === "error" ? (
                  <p>{resolution.status === "error" ? resolution.message : project.message}</p>
                ) : <p>불러오는 중…</p>}
              </section>
            ) : null) : (
              <DailyPlannerView state={daily} folders={catalog?.folders ?? []} selectedDate={selectedDate} isTodayView={selectedDate === today} todayFolderIds={todayFolderIds} sessions={sessions} nodeConnectivity={nodeConnectivity} onSaveMemo={saveMemo} onOpenProject={(folderId) => { void selectFolder(catalog?.folders.find((folder) => folder.id === folderId) ?? null); }} onOpenTask={openTask} onCompleteTask={plannerActions.completeTask} onToggleTaskToday={plannerActions.toggleTaskToday} onMoveTaskToProject={taskProjectMove.openTask} onOpenRitual={() => setRitualOpen(true)} onCreateTask={() => setCreateOpen(true)} />
            )}
          </div>
        </div>
      </main>
      <div className="v3-session-panel-resize" data-testid="v3-session-panel-resize-handle" aria-hidden="true">
        <DragHandle onDrag={sessionPanel.resize} widthPx={V3_PANEL_GAP_PX} />
      </div>
      <V3SessionPanel ref={sessionPanel.panelRef} sessions={panelSessions} boardItems={catalog?.boardItems ?? []} folders={catalog?.folders ?? []} nodeConnectivity={nodeConnectivity} activeSessionId={activeSessionKey} acknowledgedReviewIds={acknowledgedReviewIds} onOpenSession={sessionPanel.openSession} onRenameSession={plannerActions.renameSession} onDeleteSessions={plannerActions.deleteSessions} onAcknowledged={acknowledgeReview} />
      {workspaceOpen && (workspaceTask || activeSession) ? (
        <TaskWorkspace
          task={workspaceTask}
          folderSections={selectedFolder ? <FolderWorkspaceSections
            folder={selectedFolder}
            project={folderAggregate ? project : { status: "loading", data: null, message: null }}
            children={folderAggregate?.subfolders ?? childFolders}
            hasMoreChildren={Boolean(folderAggregate?.nextSubfolderCursor)}
            childrenLoadingMore={subfoldersLoadingMore}
            onLoadMoreChildren={() => { void loadMoreSubfolders(); }}
            knownPages={projects}
            sessions={sessions}
            nodeConnectivity={nodeConnectivity}
            todayFolderIds={todayFolderIds}
            invalidationKey={projectContextInvalidationKey}
            newDocumentOpen={newDocumentOpen}
            newDocumentTitle={newDocumentTitle}
            documentsLoadingMore={projectDocumentsLoadingMore}
            onLoadMoreDocuments={() => { void loadMoreProjectDocuments(); }}
            onOpenFolder={(folder) => { void selectFolder(folder); }}
            onOpenDocument={(page) => openProjectDocument(page.id)}
            onToggleNewDocument={() => setNewDocumentOpen((value) => !value)}
            onNewDocumentTitle={setNewDocumentTitle}
            onCreateDocument={() => { void createDocument(); }}
            onCompleteFolder={plannerActions.completeTask}
            onToggleFolderToday={plannerActions.toggleTaskToday}
            onBlocksChanged={applyTaskBlocks}
          /> : null}
          checklistEnabled={selectedFolder?.checklistEnabled ?? false}
          parentFolder={parentFolder}
          onOpenParent={(folder) => { void selectFolder(folder); }}
          onToggleChecklist={async (enabled) => {
            if (!selectedFolder) return;
            try {
              const result = await setFolderChecklistEnabled(selectedFolder, enabled);
              const state = useDashboardStore.getState();
              if (state.catalog) state.setCatalog({
                ...state.catalog,
                folders: state.catalog.folders.map((folder) => folder.id === result.folder.id
                  ? result.folder
                  : folder),
              });
            } catch (error) {
              notifyWriteFailure("체크리스트 변경", error);
              throw error;
            }
          }}
          taskResolutionError={sessionPanel.workspaceTaskError}
          projectTitle={projectTitle}
          projectFolderId={projectFolderId}
          folders={catalog?.folders ?? []}
          contextInvalidationKey={projectContextInvalidationKey}
          sessions={sessions}
          runSessionLoadStates={runSessionResolution.loadStateById}
          runHistoryTotal={workspaceTask?.sessionIds.length ?? 0}
          runHistoryHasMore={Boolean(folderSessions.state?.nextCursor)}
          runHistoryLoading={Boolean(folderSessions.state?.loadingMore)}
          onLoadMoreRuns={folderSessions.loadMore}
          activeSession={activeSession}
          focusRequest={sessionPanel.focusRequest}
          onFocusRequestHandled={sessionPanel.acknowledgeFocusRequest}
          chatOpen={chatOpen}
          chatInputDisabled={chatInputDisabled}
          fileUploadUrl={fileUploadUrl}
          sessionDefaults={sessionDefaults}
          mobileMode={mobileMode}
          mobileTab={mobileTab}
          historyEnabled={historyEnabled}
          sessionStreamActive={detailActive}
          sessionConnectionStatus={sessionConnectionStatus}
          reconnectSession={reconnectSession}
          onChatVisibilityChange={setDetailChatVisible}
          taskMoveTargets={currentTasks}
          taskInToday={workspaceTask ? todayFolderIds.has(workspaceTask.page.id) : false}
          onReturnToToday={returnToPlanner}
          onToggleTaskToday={() => workspaceTask ? plannerActions.toggleTaskToday(workspaceTask) : Promise.reject(new Error("연결된 폴더가 없습니다"))}
          onCloseWorkspace={closeWorkspace}
          onCloseChat={() => { if (mobileMode) switchMobileTab("task"); else setChatOpen(false); }}
          onOpenSession={openSession}
          onRenameTaskTitle={(title) => workspaceTask ? plannerActions.renameFolderPageTitle(workspaceTask, title) : Promise.reject(new Error("연결된 업무가 없습니다"))}
          onSaveDescription={saveDescription}
          onRenameSession={plannerActions.renameSession}
          onDeleteSessions={plannerActions.deleteSessions}
          onMoveSession={plannerActions.moveSession}
          onTaskBlocksChanged={applyTaskBlocks}
          onAcknowledgedReview={acknowledgeReview}
        />
      ) : null}
      <V3StandaloneDocumentInspector
        open={documentInspectorOpen}
        documentId={standaloneDocumentId}
        container={standaloneDocumentContainer}
        onClose={() => { setDocumentInspectorOpen(false); setStandaloneDocumentId(null); setStandaloneDocumentContainer(null); }}
        onDeleted={(boardItemId) => useDashboardStore.getState().removeBoardItem(boardItemId)}
      />
      <AskQuestionBanner
        treeEnabled={detailActive}
        onOpenDetail={() => {
          applyMobileState(revealAttentionDetail({
            activeTab: mobileTab,
            selectedFolderId: selectedFolderId,
            selectedRunId: activeSessionKey,
            workspaceOpen,
            chatOpen,
          }, mobileMode));
        }}
      />
      <TaskProjectMoveDialog {...taskProjectMove.dialogProps} />
      <MobilePlannerTabs activeTab={mobileTab} onSelect={switchMobileTab} />
      <RitualModal open={ritualOpen} today={today} reviewCount={reviewSessions.length} onClose={() => setRitualOpen(false)} onActionApplied={applyRitualAction} onFocusSessionPanel={() => { requestAnimationFrame(() => sessionPanel.panelRef.current?.focus({ preventScroll: true })); }} />
      <ConfigModal open={configOpen} onOpenChange={setConfigOpen} />
      <V3SearchModal open={searchOpen} onOpenChange={setSearchOpen} sessions={sessions} onOpenSession={sessionPanel.openSessionById} onOpenFolder={(folderId) => { const folder = catalog?.folders.find((candidate) => candidate.id === folderId); if (folder) void selectFolder(folder); }} />
      <V3Toast message={toast} />
    </div>
  );
}
