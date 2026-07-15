import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  DragHandle,
  LiquidGlassCanvas,
  LiquidGlassProvider,
  WallpaperLayer,
  initTheme,
  useAuth,
  useDashboardStore,
  useInitialCatalogLoad,
  useReadPositionSync,
  useSessionProvider,
  useGlassSurface,
  useUserPreferencesSync,
  type SessionReviewAcknowledgeResult,
  type SessionSummary,
} from "@seosoyoung/soul-ui";
import { clampDashboardLeftSidebarWidth, DASHBOARD_LEFT_SIDEBAR_DEFAULT_WIDTH, readDashboardLeftSidebarWidth, writeDashboardLeftSidebarWidth } from "@seosoyoung/soul-ui/components/dashboard-sidebar-collapse";
import { createPageApiClient } from "@seosoyoung/soul-ui/page";
import { DASHBOARD_CARD_GAP_PX, DASHBOARD_PANEL_GAP_PX } from "@seosoyoung/soul-ui/components/dashboard-spacing";

import { useNodes } from "../hooks/useNodes";
import { ConfigModal } from "../components/ConfigModal";
import { SearchModal } from "../components/SearchModal";
import { orchestratorSessionProvider } from "../providers";
import { useOrchestratorStore } from "../store/orchestrator-store";
import { NewTaskForm } from "./NewTaskForm";
import { DailyPlannerView, ProjectPlannerView } from "./PlannerViews";
import { ProjectFolderResolutionView } from "./ProjectFolderResolutionView";
import { MobilePlannerTabs, useMobilePlannerMode } from "./MobilePlannerTabs";
import { RitualModal } from "./RitualModal";
import { ReviewQueuePanel } from "./ReviewQueuePanel";
import { TaskWorkspace } from "./TaskWorkspace";
import { V3Navigation } from "./V3Navigation";
import { V3StandaloneInspector } from "./V3StandaloneInspector";
import { V3GlobalToolbar } from "./V3GlobalToolbar";
import { useV3PlannerActions } from "./use-v3-planner-actions";
import {
  reduceMobilePlannerEscape,
  selectMobilePlannerTab,
  type MobilePlannerState,
  type MobilePlannerTab,
} from "./mobile-planner-state";
import { BrowserPlannerMutationPort } from "./planner-browser-port";
import { useTaskStarChanges } from "./task-star-store";
import {
  createPlannerDataDependencies,
  loadStarredPlannerTask,
  type PlannerTask,
} from "./planner-data";
import { resolveProjectFolderId } from "./planner-model";
import { resolveProjectPage } from "./project-page-actions";
import {
  createPlannerTask,
  plannerTaskCreationErrorLabel,
} from "./planner-task-creation";
import {
  fetchPageSessionDefaults,
  promoteMountedDocument,
  saveTaskDescription,
  type PageSessionDefaults,
} from "./task-workspace-api";
import {
  activateRunSession,
  resolveRunSessions,
} from "./task-workspace-model";
import {
  buildMobileTaskOptions,
  dateKey,
  errorText,
  recentDates,
} from "./v3-dashboard-utils";
import {
  usePlannerCollections,
  useTaskRunHistory,
} from "./use-v3-planner-reads";
import { useProjectFolderController } from "./use-project-folder-controller";
import { reviewQueueSessions } from "./review-queue-model";
import { invalidateV3, useV3InvalidationKey } from "./v3-live-invalidation-plane";
import { useV3LiveDataPlane } from "./use-v3-live-data-plane";
import { openDocumentInV3, openSessionInV3 } from "./v3-inspector-model";
import "./v3-planner.css";
import "./v3-planner-surfaces.css";
import "./v3-task-workspace.css";

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
  const refreshKey = useV3InvalidationKey(["session", "catalog", "runbook", "page", "replay", "local"]);
  const projectContextInvalidationKey = useV3InvalidationKey(["page", "replay", "local"]);
  const invalidateLocal = useCallback(() => invalidateV3("local"), []);
  const [createOpen, setCreateOpen] = useState(false);
  const [ritualOpen, setRitualOpen] = useState(false);
  const [reviewQueueOpen, setReviewQueueOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
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
  const [toast, setToast] = useState<string | null>(null);
  const [navigationWidth, setNavigationWidth] = useState(() => readDashboardLeftSidebarWidth());
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const { user } = useAuth();
  useUserPreferencesSync(user?.email ?? null);
  useInitialCatalogLoad(true);
  useReadPositionSync();
  useNodes();
  const mobileMode = useMobilePlannerMode();

  const catalog = useDashboardStore((state) => state.catalog);
  const activeSessionKey = useDashboardStore((state) => state.activeSessionKey);
  const activeSessionSummary = useDashboardStore((state) => state.activeSessionSummary);
  const setActiveSession = useDashboardStore((state) => state.setActiveSession);
  const setActiveSessionSummary = useDashboardStore((state) => state.setActiveSessionSummary);
  const setActiveTab = useDashboardStore((state) => state.setActiveTab);
  const setActiveBoardDocument = useDashboardStore((state) => state.setActiveBoardDocument);
  const nodes = useOrchestratorStore((state) => state.nodes);
  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);
  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  const taskStarChanges = useTaskStarChanges();
  const {
    daily,
    todayTaskIds,
    setTaskTodayPresence,
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
  } = usePlannerCollections({
    api,
    dependencies: dataDependencies,
    selectedDate,
    today,
    selectedProject,
    taskStarChanges,
    refreshKey,
    notify,
  });
  const plannerActions = useV3PlannerActions({
    api, invalidate: invalidateLocal, notify, todayTaskIds, setTaskTodayPresence,
  });
  const currentTasks = useMemo(
    () => [
      ...(daily.data?.tasks ?? []),
      ...(selectedProject ? (project.data?.tasks ?? []) : []),
    ],
    [daily.data?.tasks, project.data?.tasks, selectedProject],
  );
  const selectedTask = currentTasks.find((task) => task.page.id === selectedTaskId) ?? selectedTaskSnapshot;
  const runHistory = useTaskRunHistory({
    dependencies: dataDependencies,
    task: selectedTask,
    workspaceOpen,
    refreshKey,
    notify,
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
    catalogSessions: [],
    targetedSessions: targetedRunSessions,
    targetedLoading: targetedRunSessionsLoading,
  }), [plannerSessionIds, targetedRunSessions, targetedRunSessionsLoading]);
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

  const activeSession = sessions.find((session) => session.agentSessionId === activeSessionKey)
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
    activateRunSession(session, { setActiveSessionSummary, setActiveSession, setActiveTab });
    setWorkspaceOpen(true);
    setChatOpen(true);
    if (mobileMode && selectedTaskId) setMobileTab("chat");
  }, [mobileMode, selectedTaskId, setActiveSession, setActiveSessionSummary, setActiveTab]);
  const openReviewSession = useCallback((session: SessionSummary) => {
    openSessionInV3(session, { setActiveSessionSummary, setActiveSession, setActiveTab, setInspectorOpen });
  }, [setActiveSession, setActiveSessionSummary, setActiveTab]);
  const openProjectDocument = useCallback((documentId: string) => {
    openDocumentInV3(documentId, { setActiveBoardDocument, setInspectorOpen });
  }, [setActiveBoardDocument]);
  const openTaskDocument = useCallback((documentId: string) => {
    openDocumentInV3(documentId, {
      setActiveBoardDocument,
      setInspectorOpen: () => { setChatOpen(true); if (mobileMode) setMobileTab("chat"); },
    });
  }, [mobileMode, setActiveBoardDocument]);
  const createTask = async (title: string, folderId: string, description: string) => {
    const folder = catalog?.folders.find((item) => item.id === folderId);
    if (!folder) { notify("선택한 프로젝트를 찾을 수 없습니다"); return; }
    setCreatePending(true);
    try {
      const projectPage = await resolveProjectPage(api, folder, projects);
      if (!projectPage) {
        notify("이 폴더는 프로젝트에 연결되지 않아 새 업무를 만들 수 없습니다");
        return;
      }
      const dailyPage = selectedDate === today && daily.data ? daily.data.daily.page : (await api.getDailyPage(today)).page;
      await createPlannerTask({ title, description, dailyPageId: dailyPage.id, projectPageId: projectPage.id, folderId }, mutationPort);
      setCreateOpen(false);
      clearProject();
      setSelectedDate(today);
      invalidateLocal();
      notify(`새 업무 생성 · ${title}`);
    } catch (error) {
      const label = plannerTaskCreationErrorLabel(error);
      notify(`${label} 실패 · ${errorText(error)}`);
    } finally {
      setCreatePending(false);
    }
  };
  const saveMemo = async (blockId: string | null, text: string) => {
    if (!daily.data) return;
    try {
      await mutationPort.saveMemo({ pageId: daily.data.daily.page.id, blockId, text });
      invalidateLocal();
      notify("오늘 메모 저장됨");
    } catch (error) {
      notify(`오늘 메모 저장 실패 · ${errorText(error)}`);
      throw error;
    }
  };
  const createDocument = async () => {
    const title = newDocumentTitle.trim();
    if (!title || !selectedProject) return;
    try {
      await mutationPort.createDocument({ title, sourcePageId: selectedProject.id });
      setNewDocumentTitle("");
      setNewDocumentOpen(false);
      invalidateLocal();
      notify(`새 문서 생성 · ${title}`);
    } catch (error) { notify(`새 문서 생성 실패 · ${errorText(error)}`); }
  };
  const saveDescription = async (markdown: string) => {
    if (!selectedTask) return;
    try {
      await saveTaskDescription(api, selectedTask.page.id, markdown);
      invalidateLocal();
      notify("업무 설명 저장됨");
    } catch (error) {
      notify(`업무 설명 저장 실패 · ${errorText(error)}`);
      throw error;
    }
  };
  const promoteDocument = async (blockId: string) => {
    if (!selectedTask?.projectPageId) throw new Error("프로젝트가 연결되지 않은 업무입니다");
    try {
      await promoteMountedDocument(api, selectedTask.page.id, selectedTask.projectPageId, blockId);
      invalidateLocal();
      notify("문서를 프로젝트로 승격했습니다");
    } catch (error) {
      notify(`문서 승격 실패 · ${errorText(error)}`);
      throw error;
    }
  };
  const acknowledgeReview = (result: SessionReviewAcknowledgeResult) => {
    setAcknowledgedReviewIds((current) => new Set([...current, result.agentSessionId]));
    const state = useDashboardStore.getState();
    const current = state.activeSessionSummary;
    if (current?.agentSessionId === result.agentSessionId) {
      state.setActiveSessionSummary({ ...current, reviewState: result.reviewState });
    }
    invalidateLocal();
  };
  const reviewSessions = reviewQueueSessions(sessions)
    .filter((session) => !acknowledgedReviewIds.has(session.agentSessionId));
  const selectedFolderName = catalog?.folders.find((folder) => folder.id === selectedFolderId)?.name ?? "프로젝트";
  const shellStyle = {
    "--v3-card-gap": `${DASHBOARD_CARD_GAP_PX}px`,
    "--v3-panel-gap": `${DASHBOARD_PANEL_GAP_PX}px`,
    "--v3-navigation-width": `${navigationWidth || DASHBOARD_LEFT_SIDEBAR_DEFAULT_WIDTH}px`,
  } as CSSProperties;
  const workspaceTask = selectedTask ? { ...selectedTask, sessionIds: runHistory.sessionIds } : null;
  const projectTitle = projects.find((item) => item.id === workspaceTask?.projectPageId)?.title ?? "미분류";
  const selectedTaskProject = projects.find((item) => item.id === workspaceTask?.projectPageId) ?? null;
  const projectFolderId = selectedTaskProject ? resolveProjectFolderId(selectedTaskProject, catalog?.folders ?? []) : null;
  const inspectorSession = activeSessionSummary?.agentSessionId === activeSessionKey ? activeSessionSummary : activeSession;

  return (
    <div className="v3-shell isolate font-sans" data-mobile-tab={mobileTab} style={shellStyle}>
      <WallpaperLayer />
      <LiquidGlassCanvas />
      <V3GlobalToolbar
        onOpenConfig={() => setConfigOpen(true)}
        onOpenNewTask={() => setCreateOpen(true)}
        onOpenRitual={() => setRitualOpen(true)}
        onOpenSearch={() => setSearchOpen(true)}
      />
      <V3Navigation dates={dates} selectedDate={selectedDate} folders={catalog?.folders ?? []} selectedFolderId={selectedFolderId} reviewSessions={reviewSessions} starredTasks={starredTasks} starredTasksHasMore={starredTasksHasMore} starredTasksLoading={starredTasksLoading || starredTasksLoadingMore} todayTaskIds={todayTaskIds} completedTaskIds={new Set(currentTasks.filter((task) => task.status === "completed").map((task) => task.page.id))} onLoadMoreStarredTasks={() => { void loadMoreStarredTasks(); }} onSelectDate={(date) => { clearProject(); setSelectedDate(date); }} onOpenReviewQueue={() => setReviewQueueOpen(true)} onSelectFolder={(folder) => { void projectSelection.openFolder(api, folder, projects, notify); setNewDocumentOpen(false); }} onSelectTask={(task) => { void openStarredTask(task); }} onCompleteTask={plannerActions.completeStarredTask} onToggleTaskToday={plannerActions.toggleStarredTaskToday} onCreateProject={(title) => projectSelection.createProject(title, api, projects, notify)} onCreateTask={(folderId) => { projectSelection.setSelectedFolderId(folderId); setCreateOpen(true); }} onRenameSession={plannerActions.renameSession} onDeleteSessions={plannerActions.deleteSessions} />
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
            {createOpen ? <NewTaskForm folders={catalog?.folders ?? []} projectPages={projects} initialFolderId={selectedFolderId} pending={createPending} onCreate={(title, folderId, description) => { void createTask(title, folderId, description); }} onCancel={() => setCreateOpen(false)} /> : null}
            {selectedProject ? (
              <ProjectPlannerView state={project} sessions={sessions} todayTaskIds={todayTaskIds} newDocumentOpen={newDocumentOpen} newDocumentTitle={newDocumentTitle} tasksLoadingMore={projectTasksLoadingMore} documentsLoadingMore={projectDocumentsLoadingMore} invalidationKey={projectContextInvalidationKey} onLoadMoreTasks={() => { void loadMoreProjectTasks(); }} onLoadMoreDocuments={() => { void loadMoreProjectDocuments(); }} onBack={clearProject} onOpenTask={openTask} onCompleteTask={plannerActions.completeTask} onToggleTaskToday={plannerActions.toggleTaskToday} onOpenDocument={(page) => openProjectDocument(page.id)} onToggleNewDocument={() => setNewDocumentOpen((value) => !value)} onNewDocumentTitle={setNewDocumentTitle} onCreateDocument={() => { void createDocument(); }} />
            ) : selectedFolderId ? (
              <ProjectFolderResolutionView state={resolution} title={selectedFolderName} onRetry={() => { void projectSelection.retry(); }} />
            ) : (
              <DailyPlannerView state={daily} selectedDate={selectedDate} isTodayView={selectedDate === today} todayTaskIds={todayTaskIds} sessions={sessions} onSaveMemo={saveMemo} onOpenProject={(pageId) => projectSelection.openProjectPage(pageId, projects, catalog?.folders ?? [])} onOpenTask={openTask} onCompleteTask={plannerActions.completeTask} onToggleTaskToday={plannerActions.toggleTaskToday} />
            )}
          </div>
        </div>
      </main>
      {workspaceOpen && workspaceTask ? (
        <TaskWorkspace task={workspaceTask} projectTitle={projectTitle} projectFolderId={projectFolderId} sessions={sessions} runSessionLoadStates={runSessionResolution.loadStateById} runHistoryTotal={runHistory.total} runHistoryHasMore={runHistory.hasMore} runHistoryLoading={runHistory.loading} onLoadMoreRuns={() => { void runHistory.loadMore(); }} activeSession={activeSession} chatOpen={chatOpen} chatInputDisabled={chatInputDisabled} fileUploadUrl={fileUploadUrl} sessionDefaults={sessionDefaults} mobileMode={mobileMode} mobileTab={mobileTab} taskMoveTargets={currentTasks} onReturnToToday={returnToPlanner} onCloseWorkspace={closeWorkspace} onCloseChat={() => { if (mobileMode) switchMobileTab("task"); else setChatOpen(false); }} onOpenDocument={openTaskDocument} onOpenSession={openSession} onRenameTaskTitle={(title) => plannerActions.renameTaskTitle(workspaceTask, title)} onSaveDescription={saveDescription} onPromoteDocument={promoteDocument} onUnmountDocument={(blockId) => plannerActions.unmountDocument(workspaceTask, blockId)} onRenameSession={plannerActions.renameSession} onDeleteSessions={plannerActions.deleteSessions} onMoveSession={plannerActions.moveSession} onTaskBlocksChanged={invalidateLocal} onAcknowledgedReview={acknowledgeReview} />
      ) : null}
      <V3StandaloneInspector open={inspectorOpen} session={inspectorSession} chatInputDisabled={chatInputDisabled} fileUploadUrl={fileUploadUrl} onClose={() => setInspectorOpen(false)} onAcknowledgedReview={acknowledgeReview} />
      <MobilePlannerTabs activeTab={mobileTab} onSelect={switchMobileTab} />
      <RitualModal open={ritualOpen} today={today} reviewCount={reviewSessions.length} onClose={() => setRitualOpen(false)} onRefresh={invalidateLocal} onOpenReviewQueue={() => setReviewQueueOpen(true)} />
      <ReviewQueuePanel open={reviewQueueOpen} companionOpen={inspectorOpen} sessions={reviewSessions} onClose={() => setReviewQueueOpen(false)} onOpenSession={openReviewSession} onRenameSession={plannerActions.renameSession} onDeleteSessions={plannerActions.deleteSessions} onAcknowledged={acknowledgeReview} />
      <ConfigModal open={configOpen} onOpenChange={setConfigOpen} />
      <SearchModal open={searchOpen} onOpenChange={setSearchOpen} sessions={sessions} />
      <div className={`v3-toast${toast ? " is-visible" : ""}`} role="status" aria-live="polite">{toast}</div>
    </div>
  );
}
