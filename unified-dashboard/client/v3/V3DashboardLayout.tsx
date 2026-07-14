import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  DragHandle,
  LiquidGlassCanvas,
  LiquidGlassProvider,
  WallpaperLayer,
  initTheme,
  useAuth,
  useDashboardStore,
  useReadPositionSync,
  useSessionListProvider,
  useSessionProvider,
  useGlassSurface,
  useUserPreferencesSync,
  type SessionReviewAcknowledgeResult,
  type SessionSummary,
} from "@seosoyoung/soul-ui";
import {
  clampDashboardLeftSidebarWidth,
  DASHBOARD_LEFT_SIDEBAR_DEFAULT_WIDTH,
  readDashboardLeftSidebarWidth,
  writeDashboardLeftSidebarWidth,
} from "@seosoyoung/soul-ui/components/dashboard-sidebar-collapse";
import { createPageApiClient } from "@seosoyoung/soul-ui/page";
import {
  DASHBOARD_CARD_GAP_PX,
  DASHBOARD_PANEL_GAP_PX,
} from "@seosoyoung/soul-ui/components/dashboard-spacing";
import type { ReviewState } from "@seosoyoung/soul-ui/shared/session-types";

import { useNodes } from "../hooks/useNodes";
import { ConfigModal } from "../components/ConfigModal";
import { SearchModal } from "../components/SearchModal";
import { orchestratorSessionProvider } from "../providers";
import { useOrchestratorStore } from "../store/orchestrator-store";
import { NewTaskForm } from "./NewTaskForm";
import {
  DailyPlannerView,
  ProjectPlannerView,
  type PlannerLoadState,
} from "./PlannerViews";
import { MobilePlannerTabs, useMobilePlannerMode } from "./MobilePlannerTabs";
import { RitualModal } from "./RitualModal";
import { TaskWorkspace } from "./TaskWorkspace";
import { V3Navigation } from "./V3Navigation";
import { V3GlobalToolbar } from "./V3GlobalToolbar";
import { useV3PlannerActions } from "./use-v3-planner-actions";
import {
  reduceMobilePlannerEscape,
  selectMobilePlannerTab,
  type MobilePlannerState,
  type MobilePlannerTab,
} from "./mobile-planner-state";
import { BrowserPlannerMutationPort } from "./planner-browser-port";
import {
  applyProjectStarChanges,
  resolveSelectedProject,
  useProjectStarChanges,
} from "./project-star-store";
import {
  createPlannerDataDependencies,
  loadDailyPlanner,
  loadProjectPlanner,
  type DailyPlannerData,
  type PlannerTask,
  type ProjectPlannerData,
} from "./planner-data";
import { resolveProjectFolderId } from "./planner-model";
import {
  createPlannerTask,
  PlannerTaskCreationError,
  type PlannerTaskCreationPhase,
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
import "./v3-planner.css";
import "./v3-planner-surfaces.css";
import "./v3-task-workspace.css";

const CREATION_ERROR_LABEL: Record<PlannerTaskCreationPhase, string> = {
  page: "업무 페이지 생성",
  runbook: "런북 생성",
  reference: "업무-런북 연결",
  project_mount: "프로젝트 편입",
};
const NEEDS_REVIEW: ReviewState = "needs_review";

export function V3DashboardLayout() {
  return (
    <LiquidGlassProvider renderDefaultCanvas={false}>
      <V3DashboardContent />
    </LiquidGlassProvider>
  );
}

function V3DashboardContent() {
  const today = useMemo(() => dateKey(new Date()), []);
  const dates = useMemo(() => recentDates(today), [today]);
  const api = useMemo(() => createPageApiClient(), []);
  const dataDependencies = useMemo(() => createPlannerDataDependencies(), []);
  const mutationPort = useMemo(() => new BrowserPlannerMutationPort(api), [api]);
  const [selectedDate, setSelectedDate] = useState(today);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [daily, setDaily] = useState<PlannerLoadState<DailyPlannerData>>({ status: "loading", data: null, message: null });
  const [project, setProject] = useState<PlannerLoadState<ProjectPlannerData>>({ status: "loading", data: null, message: null });
  const [refreshKey, setRefreshKey] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [ritualOpen, setRitualOpen] = useState(false);
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
  useReadPositionSync();
  useNodes();
  const mobileMode = useMobilePlannerMode();

  const catalog = useDashboardStore((state) => state.catalog);
  const activeSessionKey = useDashboardStore((state) => state.activeSessionKey);
  const activeSessionSummary = useDashboardStore((state) => state.activeSessionSummary);
  const setActiveSession = useDashboardStore((state) => state.setActiveSession);
  const setActiveSessionSummary = useDashboardStore((state) => state.setActiveSessionSummary);
  const setActiveTab = useDashboardStore((state) => state.setActiveTab);
  const nodes = useOrchestratorStore((state) => state.nodes);
  const currentTasks = useMemo(
    () => [...(daily.data?.tasks ?? []), ...(project.data?.tasks ?? [])],
    [daily.data?.tasks, project.data?.tasks],
  );
  const plannerSessionIds = useMemo(
    () => [...new Set(currentTasks.flatMap((task) => task.sessionIds))].sort(),
    [currentTasks],
  );
  const {
    sessions: targetedRunSessions,
    loading: targetedRunSessionsLoading,
  } = useSessionListProvider({
    enabled: plannerSessionIds.length > 0,
    getSessionProvider: () => orchestratorSessionProvider,
    sessionIds: plannerSessionIds,
    streamEnabled: false,
    initialCatalogLoadEnabled: false,
    folderCountsEnabled: false,
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

  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);
  const plannerActions = useV3PlannerActions({ api, setRefreshKey, notify });
  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  useEffect(() => {
    let active = true;
    setDaily((current) => ({ status: "loading", data: current.data, message: null }));
    void loadDailyPlanner(api, selectedDate, dataDependencies).then((data) => {
      if (active) setDaily({ status: "ready", data, message: null });
    }).catch((error: unknown) => {
      if (active) setDaily((current) => ({ status: "error", data: current.data, message: errorText(error) }));
    });
    return () => { active = false; };
  }, [api, dataDependencies, refreshKey, selectedDate]);

  const projectStarChanges = useProjectStarChanges();
  const storedProjects = daily.data?.projects ?? [];
  const projects = applyProjectStarChanges(storedProjects, projectStarChanges);
  const selectedProject = resolveSelectedProject(storedProjects, projectStarChanges, selectedProjectId);
  useEffect(() => {
    if (!selectedProject) return;
    let active = true;
    setProject((current) => ({ status: "loading", data: current.data?.project.id === selectedProject.id ? current.data : null, message: null }));
    void loadProjectPlanner(api, selectedProject, dataDependencies).then((data) => {
      if (active) setProject({ status: "ready", data, message: null });
    }).catch((error: unknown) => {
      if (active) setProject((current) => ({ status: "error", data: current.data, message: errorText(error) }));
    });
    return () => { active = false; };
  }, [api, dataDependencies, refreshKey, selectedProject]);

  const selectedTask = currentTasks.find((task) => task.page.id === selectedTaskId) ?? selectedTaskSnapshot;
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
      setSelectedProjectId(null);
      setSelectedDate(today);
    }
  }, [activeSessionKey, currentTasks, selectedTaskId, sessions, setActiveSession, setActiveSessionSummary, setActiveTab, today]);

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
    setSelectedProjectId(null);
    setSelectedDate(today);
  }, [today]);
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
      else if (selectedProjectId) setSelectedProjectId(null);
      else if (selectedDate !== today) setSelectedDate(today);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeSessionKey, applyMobileState, chatOpen, closeWorkspace, createOpen, mobileMode, mobileTab, newDocumentOpen, selectedDate, selectedProjectId, selectedTaskId, today, workspaceOpen]);

  const openTask = (task: PlannerTask) => {
    setSelectedTaskId(task.page.id);
    setSelectedTaskSnapshot(task);
    setWorkspaceOpen(true);
    setChatOpen(false);
    if (mobileMode) setMobileTab("task");
  };
  const openSession = useCallback((session: SessionSummary) => {
    activateRunSession(session, { setActiveSessionSummary, setActiveSession, setActiveTab });
    setWorkspaceOpen(true);
    setChatOpen(true);
    if (mobileMode && selectedTaskId) setMobileTab("chat");
  }, [mobileMode, selectedTaskId, setActiveSession, setActiveSessionSummary, setActiveTab]);

  const createTask = async (title: string, projectId: string) => {
    const projectPage = projects.find((item) => item.id === projectId);
    if (!projectPage) { notify("선택한 프로젝트를 찾을 수 없습니다"); return; }
    const folderId = resolveProjectFolderId(projectPage, catalog?.folders ?? []);
    if (!folderId) { notify("프로젝트 페이지에 런북 저장 폴더를 연결해야 합니다"); return; }
    setCreatePending(true);
    try {
      const dailyPage = selectedDate === today && daily.data ? daily.data.daily.page : (await api.getDailyPage(today)).page;
      await createPlannerTask({ title, dailyPageId: dailyPage.id, projectPageId: projectPage.id, folderId }, mutationPort);
      setCreateOpen(false);
      setSelectedProjectId(null);
      setSelectedDate(today);
      setRefreshKey((value) => value + 1);
      notify(`새 업무 생성 · ${title}`);
    } catch (error) {
      const label = error instanceof PlannerTaskCreationError ? CREATION_ERROR_LABEL[error.phase] : "새 업무 생성";
      notify(`${label} 실패 · ${errorText(error)}`);
    } finally {
      setCreatePending(false);
    }
  };

  const saveMemo = async (blockId: string | null, text: string) => {
    if (!daily.data) return;
    try {
      await mutationPort.saveMemo({ pageId: daily.data.daily.page.id, blockId, text });
      setRefreshKey((value) => value + 1);
      notify("오늘 메모 저장됨");
    } catch (error) { notify(`오늘 메모 저장 실패 · ${errorText(error)}`); }
  };
  const createDocument = async () => {
    const title = newDocumentTitle.trim();
    if (!title || !selectedProject) return;
    try {
      await mutationPort.createDocument({ title, sourcePageId: selectedProject.id });
      setNewDocumentTitle("");
      setNewDocumentOpen(false);
      setRefreshKey((value) => value + 1);
      notify(`새 문서 생성 · ${title}`);
    } catch (error) { notify(`새 문서 생성 실패 · ${errorText(error)}`); }
  };
  const saveDescription = async (markdown: string) => {
    if (!selectedTask) return;
    try {
      await saveTaskDescription(api, selectedTask.page.id, markdown);
      setRefreshKey((value) => value + 1);
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
      setRefreshKey((value) => value + 1);
      notify("문서를 프로젝트로 승격했습니다");
    } catch (error) {
      notify(`문서 승격 실패 · ${errorText(error)}`);
      throw error;
    }
  };
  const acknowledgeReview = (result: SessionReviewAcknowledgeResult) => {
    const state = useDashboardStore.getState();
    const current = state.activeSessionSummary;
    if (current?.agentSessionId === result.agentSessionId) {
      state.setActiveSessionSummary({ ...current, reviewState: result.reviewState });
    }
  };

  const reviewSessions = sessions.filter((session) => session.reviewState === NEEDS_REVIEW);
  const shellStyle = {
    "--v3-card-gap": `${DASHBOARD_CARD_GAP_PX}px`,
    "--v3-panel-gap": `${DASHBOARD_PANEL_GAP_PX}px`,
    "--v3-navigation-width": `${navigationWidth || DASHBOARD_LEFT_SIDEBAR_DEFAULT_WIDTH}px`,
  } as CSSProperties;
  const projectTitle = projects.find((item) => item.id === selectedTask?.projectPageId)?.title ?? "미분류";

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
      <V3Navigation dates={dates} selectedDate={selectedDate} projects={projects} selectedProjectId={selectedProjectId} onSelectDate={(date) => { setSelectedProjectId(null); setSelectedDate(date); }} onSelectProject={(projectId) => { setSelectedProjectId(projectId); setNewDocumentOpen(false); }} onCreateTask={(projectId) => { setSelectedProjectId(projectId); setCreateOpen(true); }} />
      <div className="v3-navigation-resize" data-testid="v3-navigation-resize-handle" aria-hidden="true">
        <DragHandle onDrag={resizeNavigation} widthPx={DASHBOARD_PANEL_GAP_PX} />
      </div>
      <main className="v3-main">
        <div
          ref={plannerSurfaceRef}
          className="v3-planner border border-glass-border glass-strong glass-chrome lg-rim"
          data-liquid-glass-webgl={plannerWebglActive ? "true" : undefined}
        >
          {createOpen ? <NewTaskForm projects={projects} initialProjectId={selectedProjectId} pending={createPending} onCreate={(title, projectId) => { void createTask(title, projectId); }} onCancel={() => setCreateOpen(false)} /> : null}
          {selectedProject ? (
            <ProjectPlannerView state={project} sessions={sessions} newDocumentOpen={newDocumentOpen} newDocumentTitle={newDocumentTitle} onBack={() => setSelectedProjectId(null)} onOpenTask={openTask} onCompleteTask={plannerActions.completeTask} onToggleTaskToday={plannerActions.toggleTaskToday} onOpenDocument={(page) => window.location.assign(`/v2/pages/${encodeURIComponent(page.id)}`)} onToggleNewDocument={() => setNewDocumentOpen((value) => !value)} onNewDocumentTitle={setNewDocumentTitle} onCreateDocument={() => { void createDocument(); }} />
          ) : (
            <DailyPlannerView state={daily} selectedDate={selectedDate} reviewSessions={reviewSessions} sessions={sessions} onOpenReview={openSession} onSaveMemo={(blockId, text) => { void saveMemo(blockId, text); }} onOpenProject={setSelectedProjectId} onOpenTask={openTask} onCompleteTask={plannerActions.completeTask} onToggleTaskToday={plannerActions.toggleTaskToday} />
          )}
        </div>
      </main>
      {workspaceOpen && selectedTask ? (
        <TaskWorkspace task={selectedTask} projectTitle={projectTitle} sessions={sessions} runSessionLoadStates={runSessionResolution.loadStateById} activeSession={activeSession} chatOpen={chatOpen} chatInputDisabled={chatInputDisabled} fileUploadUrl={fileUploadUrl} sessionDefaults={sessionDefaults} mobileMode={mobileMode} mobileTab={mobileTab} taskMoveTargets={currentTasks} onReturnToToday={returnToPlanner} onCloseWorkspace={closeWorkspace} onCloseChat={() => { if (mobileMode) switchMobileTab("task"); else setChatOpen(false); }} onOpenSession={openSession} onSaveDescription={saveDescription} onPromoteDocument={promoteDocument} onUnmountDocument={(blockId) => plannerActions.unmountDocument(selectedTask, blockId)} onRenameSession={plannerActions.renameSession} onDeleteSessions={plannerActions.deleteSessions} onMoveSession={plannerActions.moveSession} onTaskBlocksChanged={() => setRefreshKey((value) => value + 1)} onAcknowledgedReview={acknowledgeReview} />
      ) : null}
      <MobilePlannerTabs activeTab={mobileTab} onSelect={switchMobileTab} />
      <RitualModal open={ritualOpen} today={today} sessions={sessions} onClose={() => setRitualOpen(false)} onRefresh={() => setRefreshKey((value) => value + 1)} />
      <ConfigModal open={configOpen} onOpenChange={setConfigOpen} />
      <SearchModal open={searchOpen} onOpenChange={setSearchOpen} sessions={sessions} />
      <div className={`v3-toast${toast ? " is-visible" : ""}`} role="status" aria-live="polite">{toast}</div>
    </div>
  );
}
