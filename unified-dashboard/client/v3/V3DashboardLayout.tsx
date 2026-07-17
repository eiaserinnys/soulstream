import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { DragHandle, LiquidGlassCanvas, LiquidGlassProvider, WallpaperLayer, initTheme, useAuth, useDashboardStore, useInitialCatalogLoad, useReadPositionSync, useSessionProvider, useGlassSurface, useUserPreferencesSync, type SessionSummary } from "@seosoyoung/soul-ui";
import { clampDashboardLeftSidebarWidth, DASHBOARD_LEFT_SIDEBAR_DEFAULT_WIDTH, readDashboardLeftSidebarWidth, writeDashboardLeftSidebarWidth } from "@seosoyoung/soul-ui/components/dashboard-sidebar-collapse";
import { createPageApiClient } from "@seosoyoung/soul-ui/page";
import { DASHBOARD_CARD_GAP_PX, DASHBOARD_PANEL_GAP_PX } from "@seosoyoung/soul-ui/components/dashboard-spacing";
import { useNodes } from "../hooks/useNodes";
import { ConfigModal } from "../components/ConfigModal";
import { SearchModal } from "../components/SearchModal";
import { orchestratorSessionProvider } from "../providers";
import { NewTaskForm } from "./NewTaskForm";
import { DailyPlannerView, ProjectPlannerView } from "./PlannerViews";
import { ProjectFolderResolutionView } from "./ProjectFolderResolutionView";
import { MobilePlannerTabs, useMobilePlannerMode } from "./MobilePlannerTabs";
import { MobileProjectList } from "./MobileProjectList";
import { RitualModal } from "./RitualModal";
import { TaskWorkspace } from "./TaskWorkspace";
import { TaskProjectMoveDialog } from "./TaskProjectMoveDialog";
import { V3Navigation } from "./V3Navigation";
import { V3SessionPanel } from "./V3SessionPanel";
import { V3StandaloneDocumentInspector } from "./V3StandaloneDocumentInspector";
import { V3GlobalToolbar } from "./V3GlobalToolbar";
import { V3Toast } from "./V3Toast";
import { useV3PlannerActions } from "./use-v3-planner-actions";
import { useV3Notifications } from "./use-v3-notifications";
import {
  reduceMobilePlannerEscape,
  selectMobilePlannerTab,
  type MobilePlannerState,
  type MobilePlannerTab,
} from "./mobile-planner-state";
import { BrowserPlannerMutationPort } from "./planner-browser-port";
import { useTaskStarChanges } from "./task-star-store";
import { createPlannerDataDependencies, loadStarredPlannerTask, type PlannerTask } from "./planner-data";
import { fetchPageSessionDefaults, type PageSessionDefaults } from "./task-workspace-api";
import { activateRunSession, resolveRunSessions } from "./task-workspace-model";
import { buildMobileTaskOptions, dateKey, errorText, recentDates } from "./v3-dashboard-utils";
import { usePlannerCollections, useTaskRunHistory } from "./use-v3-planner-reads";
import { useProjectFolderController } from "./use-project-folder-controller";
import { useV3PlannerInvalidationKeys } from "./v3-live-invalidation-plane";
import { useTaskProjectMoveController } from "./use-task-project-move-controller";
import { useV3LiveDataPlane } from "./use-v3-live-data-plane";
import { openDocumentInV3 } from "./v3-inspector-model";
import { useV3DashboardMutations } from "./use-v3-dashboard-mutations";
import { useV3MutationProjection } from "./use-v3-mutation-projection";
import { useV3SessionPanelController } from "./use-v3-session-panel-controller";
import { useSessionNodeConnectivity } from "./use-session-node-connectivity";
import { useProjectNavigationMutations } from "./use-project-navigation-mutations";
import "./v3-dashboard-styles";
export function V3DashboardLayout() {
  return <LiquidGlassProvider renderDefaultCanvas={false}><V3DashboardContent /></LiquidGlassProvider>;
}
function V3DashboardContent() {
  const today = useMemo(() => dateKey(new Date()), []);
  const dates = useMemo(() => recentDates(today), [today]);
  const api = useMemo(() => createPageApiClient(), []);
  const dataDependencies = useMemo(() => createPlannerDataDependencies(), []);
  const mutationPort = useMemo(() => new BrowserPlannerMutationPort(api), [api]);
  const [selectedDate, setSelectedDate] = useState(today);
  const projectSelection = useProjectFolderController();
  const { resolution, selectedFolderId, selectedProject, clearProject } = projectSelection;
  const selectedProjectId = selectedProject?.id ?? null;
  const plannerInvalidationKeys = useV3PlannerInvalidationKeys();
  const projectContextInvalidationKey = plannerInvalidationKeys.pageDetail;
  const [createOpen, setCreateOpen] = useState(false);
  const [ritualOpen, setRitualOpen] = useState(false);
  const [documentInspectorOpen, setDocumentInspectorOpen] = useState(false);
  const [acknowledgedReviewIds, setAcknowledgedReviewIds] = useState<ReadonlySet<string>>(() => new Set());
  const [configOpen, setConfigOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [mobileTab, setMobileTab] = useState<MobilePlannerTab>("today");
  const [createPending, setCreatePending] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedTaskSnapshot, setSelectedTaskSnapshot] = useState<PlannerTask | null>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [newDocumentOpen, setNewDocumentOpen] = useState(false);
  const [newDocumentTitle, setNewDocumentTitle] = useState("");
  const [sessionDefaults, setSessionDefaults] = useState<PageSessionDefaults | null>(null);
  const [navigationWidth, setNavigationWidth] = useState(() => readDashboardLeftSidebarWidth());
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
  const { user, refreshAuthStatus } = useAuth();
  const { toast, notify, notifyWriteFailure } = useV3Notifications(refreshAuthStatus);
  useUserPreferencesSync(user?.email ?? null);
  useInitialCatalogLoad(true);
  useReadPositionSync();
  useNodes();
  const mobileMode = useMobilePlannerMode();
  const catalog = useDashboardStore((state) => state.catalog);
  const catalogSessions = catalog?.sessionList ?? [];
  const activeSessionKey = useDashboardStore((state) => state.activeSessionKey);
  const activeSessionSummary = useDashboardStore((state) => state.activeSessionSummary);
  const setActiveSession = useDashboardStore((state) => state.setActiveSession);
  const setActiveSessionSummary = useDashboardStore((state) => state.setActiveSessionSummary);
  const setActiveTab = useDashboardStore((state) => state.setActiveTab);
  const setActiveBoardDocument = useDashboardStore((state) => state.setActiveBoardDocument);
  const { nodes, nodeConnectivity } = useSessionNodeConnectivity();
  const taskStarChanges = useTaskStarChanges();
  const {
    daily,
    todayTaskIds,
    setTaskTodayPresence,
    addTaskToToday,
    project,
    projects,
    starredTasks,
    starredTasksHasMore,
    starredTasksLoading,
    starredTasksLoadingMore,
    projectTasksLoadingMore,
    projectDocumentsLoadingMore,
    loadMoreStarredTasks,
    loadMoreProjectTasks,
    loadMoreProjectDocuments,
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
    taskStarChanges,
    refreshKeys: plannerInvalidationKeys,
    notify,
  });
  const currentTasks = useMemo(
    () => [
      ...(daily.data?.tasks ?? []),
      ...(selectedProject ? (project.data?.tasks ?? []) : []),
    ],
    [daily.data?.tasks, project.data?.tasks, selectedProject],
  );
  const sessionPanel = useV3SessionPanelController({
    api,
    catalog,
    currentTasks,
    acknowledgedReviewIds,
    setSelectedTaskId,
    setSelectedTaskSnapshot,
    setWorkspaceOpen,
    setChatOpen,
    notify,
  });
  const clearSessionPanelFocus = sessionPanel.clearFocusRequest;
  const selectedTask = useMemo(
    () => currentTasks.find((task) => task.page.id === selectedTaskId) ?? selectedTaskSnapshot,
    [currentTasks, selectedTaskId, selectedTaskSnapshot],
  );
  const runHistory = useTaskRunHistory({
    dependencies: dataDependencies,
    task: selectedTask,
    workspaceOpen,
    refreshKey: plannerInvalidationKeys.runHistory,
    notify,
  });
  const removeRunHistorySessions = runHistory.removeSessions;
  const moveRunHistorySession = runHistory.moveSession;
  const { patchPlannerTask, removeSessionsFromPlanner, moveSessionInPlanner, moveTaskProjectInPlanner } = useV3MutationProjection({
    patchLoadedTask, removeLoadedSessions, moveLoadedSession, moveLoadedTaskProject, removeRunHistorySessions, moveRunHistorySession, setSelectedTaskSnapshot,
  });
  const plannerActions = useV3PlannerActions({
    api,
    notify,
    notifyWriteFailure,
    todayTaskIds,
    setTaskTodayPresence,
    addTaskToToday,
    patchTask: patchPlannerTask,
    removeSessionsFromPlanner,
    moveSessionInPlanner,
    moveTaskProjectInPlanner,
    refreshTask,
  });
  const taskProjectMove = useTaskProjectMoveController({
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
      ...runHistory.sessionIds,
    ])].sort(),
    [currentTasks, daily.data?.reviewSessionIds, runHistory.sessionIds],
  );
  const {
    sessions: targetedRunSessions,
    loading: targetedRunSessionsLoading,
  } = useV3LiveDataPlane({
    sessionIds: plannerSessionIds,
    pageIds: [daily.data?.daily.page.id, selectedProjectId, ...currentTasks.map((task) => task.page.id), ...starredTasks.map((page) => page.id)],
  });
  const runSessionResolution = useMemo(() => resolveRunSessions({
    sessionIds: plannerSessionIds,
    catalogSessions,
    targetedSessions: targetedRunSessions,
    targetedLoading: targetedRunSessionsLoading,
  }), [catalogSessions, plannerSessionIds, targetedRunSessions, targetedRunSessionsLoading]);
  const sessions = runSessionResolution.sessions;
  useSessionProvider({
    sessionKey: activeSessionKey,
    getSessionProvider: () => orchestratorSessionProvider,
  });
  const mobileTaskOptions = useMemo(
    () => buildMobileTaskOptions(currentTasks, sessions),
    [currentTasks, sessions],
  );
  useEffect(() => {
    if (!workspaceOpen || !selectedTaskId) {
      setSessionDefaults(null);
      return;
    }
    let active = true;
    void fetchPageSessionDefaults(selectedTaskId).then((defaults) => {
      if (active) setSessionDefaults(defaults);
    }).catch((error: unknown) => {
      if (active) notify(`실행 기본값 조회 실패 · ${errorText(error)}`);
    });
    return () => { active = false; };
  }, [notify, selectedTaskId, workspaceOpen]);
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
    setWorkspaceOpen(next.workspaceOpen);
    setChatOpen(next.chatOpen);
    if (next.selectedTaskId !== selectedTaskId) {
      const task = currentTasks.find((candidate) => candidate.page.id === next.selectedTaskId) ?? null;
      setSelectedTaskId(task?.page.id ?? null);
      if (task) setSelectedTaskSnapshot(task);
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
      setSelectedDate(today);
    }
  }, [activeSessionKey, clearProject, currentTasks, selectedTaskId, sessions, setActiveSession, setActiveSessionSummary, setActiveTab, today]);
  const switchMobileTab = useCallback((target: MobilePlannerTab) => {
    applyMobileState(selectMobilePlannerTab({
      activeTab: mobileTab,
      selectedTaskId,
      selectedRunId: activeSessionKey,
      workspaceOpen,
      chatOpen,
    }, target, mobileTaskOptions));
  }, [activeSessionKey, applyMobileState, chatOpen, mobileTab, mobileTaskOptions, selectedTaskId, workspaceOpen]);
  const returnToPlanner = useCallback(() => {
    setMobileTab("today");
    setChatOpen(false);
    setWorkspaceOpen(false);
    clearProject();
    setSelectedDate(today);
  }, [clearProject, today]);
  const closeWorkspace = useCallback(() => {
    setMobileTab("today");
    setChatOpen(false);
    setWorkspaceOpen(false);
  }, []);
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
          selectedTaskId,
          selectedRunId: activeSessionKey,
          workspaceOpen,
          chatOpen,
        }));
      }
      else if (workspaceOpen) closeWorkspace();
      else if (selectedProjectId) clearProject();
      else if (selectedDate !== today) setSelectedDate(today);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeSessionKey, applyMobileState, chatOpen, clearProject, closeWorkspace, createOpen, mobileMode, mobileTab, newDocumentOpen, selectedDate, selectedProjectId, selectedTaskId, today, workspaceOpen]);
  const openTask = (task: PlannerTask) => {
    clearSessionPanelFocus();
    setActiveSessionSummary(null);
    setActiveSession(null);
    setSelectedTaskId(task.page.id);
    setSelectedTaskSnapshot(task);
    setWorkspaceOpen(true);
    setChatOpen(!mobileMode);
    if (mobileMode) setMobileTab("task");
  };
  const openStarredTask = async (page: typeof starredTasks[number]) => {
    try { openTask(await loadStarredPlannerTask(api, page)); }
    catch (error) { notify(`별표 업무 열기 실패 · ${errorText(error)}`); }
  };
  const openSession = useCallback((session: SessionSummary) => {
    clearSessionPanelFocus();
    activateRunSession(session, { setActiveSessionSummary, setActiveSession, setActiveTab });
    setWorkspaceOpen(true);
    setChatOpen(true);
    if (mobileMode && selectedTaskId) setMobileTab("chat");
  }, [clearSessionPanelFocus, mobileMode, selectedTaskId, setActiveSession, setActiveSessionSummary, setActiveTab]);
  const openProjectDocument = useCallback((documentId: string) => {
    openDocumentInV3(documentId, { setActiveBoardDocument, setInspectorOpen: setDocumentInspectorOpen });
  }, [setActiveBoardDocument]);
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
    selectedTaskId,
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
    patchPlannerTask,
    addTaskToToday,
    refreshDaily,
    refreshProject,
    refreshTask,
  });
  const { sessions: panelSessions, reviewSessions } = sessionPanel;
  const selectedFolderName = catalog?.folders.find((folder) => folder.id === selectedFolderId)?.name ?? "프로젝트";
  const shellStyle = {
    "--v3-card-gap": `${DASHBOARD_CARD_GAP_PX}px`,
    "--v3-panel-gap": `${DASHBOARD_PANEL_GAP_PX}px`,
    "--v3-navigation-width": `${navigationWidth || DASHBOARD_LEFT_SIDEBAR_DEFAULT_WIDTH}px`,
    "--v3-session-panel-width": `${sessionPanel.panelWidth}px`,
  } as CSSProperties;
  const workspaceTask = useMemo(
    () => selectedTask ? { ...selectedTask, sessionIds: runHistory.sessionIds } : null,
    [runHistory.sessionIds, selectedTask],
  );
  const projectTitle = projects.find((item) => item.id === workspaceTask?.projectPageId)?.title ?? "미분류";
  const projectFolderId = catalog?.folders.find(
    (folder) => folder.projectPageId === workspaceTask?.projectPageId,
  )?.id ?? null;
  return (
    <div className="v3-shell isolate font-sans" data-mobile-tab={mobileTab} data-mobile-project-open={selectedFolderId ? "true" : "false"} style={shellStyle}>
      <WallpaperLayer />
      <LiquidGlassCanvas />
      <V3GlobalToolbar
        onOpenConfig={() => setConfigOpen(true)}
        onOpenNewTask={() => setCreateOpen(true)}
        onOpenRitual={() => setRitualOpen(true)}
        onOpenSearch={() => setSearchOpen(true)}
      />
      <V3Navigation
        dates={dates} selectedDate={selectedDate} folders={catalog?.folders ?? []} selectedFolderId={selectedFolderId}
        starredTasks={starredTasks} starredTasksHasMore={starredTasksHasMore} starredTasksLoading={starredTasksLoading || starredTasksLoadingMore} todayTaskIds={todayTaskIds}
        completedTaskIds={new Set(currentTasks.filter((task) => task.status === "completed").map((task) => task.page.id))}
        onLoadMoreStarredTasks={() => { void loadMoreStarredTasks(); }}
        onSelectDate={(date) => { clearProject(); setSelectedDate(date); }} onSelectFolder={(folder) => { void projectSelection.openFolder(api, folder, projects, notify); setNewDocumentOpen(false); }}
        onSelectTask={(task) => { void openStarredTask(task); }} onCompleteTask={plannerActions.completeStarredTask} onToggleTaskToday={plannerActions.toggleStarredTaskToday}
        onMoveTaskToProject={(task) => { void taskProjectMove.openPage(task); }} {...projectNavigationMutations}
        onCreateTask={(folderId) => { projectSelection.setSelectedFolderId(folderId); setCreateOpen(true); }}
      />
      {mobileMode && mobileTab === "projects" && !selectedFolderId ? <MobileProjectList folders={catalog?.folders ?? []} onSelect={(folder) => { void projectSelection.openFolder(api, folder, projects, notify); }} /> : null}
      <div className="v3-navigation-resize" data-testid="v3-navigation-resize-handle" aria-hidden="true">
        <DragHandle onDrag={resizeNavigation} widthPx={DASHBOARD_PANEL_GAP_PX} />
      </div>
      <main className="v3-main">
        <div
          ref={plannerSurfaceRef}
          className="v3-planner border border-glass-border glass-strong glass-chrome lg-rim"
          data-liquid-glass-webgl={plannerWebglActive ? "true" : undefined}
        >
          <div className="v3-planner-scroll" data-testid="v3-planner-scroll">
            {createOpen ? <NewTaskForm folders={catalog?.folders ?? []} invalidationKey={projectContextInvalidationKey} initialFolderId={selectedFolderId} pending={createPending} onCreate={createTask} onCancel={() => setCreateOpen(false)} /> : null}
            {selectedProject ? (
              <ProjectPlannerView state={project} sessions={sessions} nodeConnectivity={nodeConnectivity} todayTaskIds={todayTaskIds} newDocumentOpen={newDocumentOpen} newDocumentTitle={newDocumentTitle} tasksLoadingMore={projectTasksLoadingMore} documentsLoadingMore={projectDocumentsLoadingMore} invalidationKey={projectContextInvalidationKey} onLoadMoreTasks={() => { void loadMoreProjectTasks(); }} onLoadMoreDocuments={() => { void loadMoreProjectDocuments(); }} onBack={clearProject} onOpenTask={openTask} onCompleteTask={plannerActions.completeTask} onToggleTaskToday={plannerActions.toggleTaskToday} onMoveTaskToProject={taskProjectMove.openTask} onOpenDocument={(page) => openProjectDocument(page.id)} onToggleNewDocument={() => setNewDocumentOpen((value) => !value)} onNewDocumentTitle={setNewDocumentTitle} onCreateDocument={() => { void createDocument(); }} />
            ) : selectedFolderId ? (
              <ProjectFolderResolutionView state={resolution} title={selectedFolderName} onRetry={() => { void projectSelection.retry(); }} />
            ) : (
              <DailyPlannerView state={daily} selectedDate={selectedDate} isTodayView={selectedDate === today} todayTaskIds={todayTaskIds} sessions={sessions} nodeConnectivity={nodeConnectivity} onSaveMemo={saveMemo} onOpenProject={(pageId) => projectSelection.openProjectPage(pageId, projects, catalog?.folders ?? [])} onOpenTask={openTask} onCompleteTask={plannerActions.completeTask} onToggleTaskToday={plannerActions.toggleTaskToday} onMoveTaskToProject={taskProjectMove.openTask} />
            )}
          </div>
        </div>
      </main>
      <div className="v3-session-panel-resize" data-testid="v3-session-panel-resize-handle" aria-hidden="true">
        <DragHandle onDrag={sessionPanel.resize} widthPx={DASHBOARD_PANEL_GAP_PX} />
      </div>
      <V3SessionPanel ref={sessionPanel.panelRef} sessions={panelSessions} boardItems={catalog?.boardItems ?? []} folders={catalog?.folders ?? []} nodeConnectivity={nodeConnectivity} activeSessionId={activeSessionKey} onOpenSession={sessionPanel.openSession} onRenameSession={plannerActions.renameSession} onDeleteSessions={plannerActions.deleteSessions} onAcknowledged={acknowledgeReview} />
      {workspaceOpen && (workspaceTask || activeSession) ? (
        <TaskWorkspace
          task={workspaceTask}
          projectTitle={projectTitle}
          projectFolderId={projectFolderId}
          folders={catalog?.folders ?? []}
          contextInvalidationKey={projectContextInvalidationKey}
          sessions={sessions}
          runSessionLoadStates={runSessionResolution.loadStateById}
          runHistoryTotal={runHistory.total}
          runHistoryHasMore={runHistory.hasMore}
          runHistoryLoading={runHistory.loading}
          onLoadMoreRuns={() => { void runHistory.loadMore(); }}
          activeSession={activeSession}
          focusRequest={sessionPanel.focusRequest}
          onFocusRequestHandled={sessionPanel.acknowledgeFocusRequest}
          chatOpen={chatOpen}
          chatInputDisabled={chatInputDisabled}
          fileUploadUrl={fileUploadUrl}
          sessionDefaults={sessionDefaults}
          mobileMode={mobileMode}
          mobileTab={mobileTab}
          taskMoveTargets={currentTasks}
          taskInToday={workspaceTask ? todayTaskIds.has(workspaceTask.page.id) : false}
          onReturnToToday={returnToPlanner}
          onToggleTaskToday={() => workspaceTask ? plannerActions.toggleTaskToday(workspaceTask) : Promise.reject(new Error("연결된 업무가 없습니다"))}
          onCloseWorkspace={closeWorkspace}
          onCloseChat={() => { if (mobileMode) switchMobileTab("task"); else setChatOpen(false); }}
          onOpenSession={openSession}
          onRenameTaskTitle={(title) => workspaceTask ? plannerActions.renameTaskTitle(workspaceTask, title) : Promise.reject(new Error("연결된 업무가 없습니다"))}
          onSaveDescription={saveDescription}
          onRenameSession={plannerActions.renameSession}
          onDeleteSessions={plannerActions.deleteSessions}
          onMoveSession={plannerActions.moveSession}
          onTaskBlocksChanged={applyTaskBlocks}
          onAcknowledgedReview={acknowledgeReview}
        />
      ) : null}
      <V3StandaloneDocumentInspector open={documentInspectorOpen} onClose={() => setDocumentInspectorOpen(false)} />
      <TaskProjectMoveDialog {...taskProjectMove.dialogProps} />
      <MobilePlannerTabs activeTab={mobileTab} onSelect={switchMobileTab} />
      <RitualModal open={ritualOpen} today={today} reviewCount={reviewSessions.length} onClose={() => setRitualOpen(false)} onActionApplied={applyRitualAction} onFocusSessionPanel={() => { requestAnimationFrame(() => sessionPanel.panelRef.current?.focus({ preventScroll: true })); }} />
      <ConfigModal open={configOpen} onOpenChange={setConfigOpen} />
      <SearchModal open={searchOpen} onOpenChange={setSearchOpen} sessions={sessions} />
      <V3Toast message={toast} />
    </div>
  );
}
