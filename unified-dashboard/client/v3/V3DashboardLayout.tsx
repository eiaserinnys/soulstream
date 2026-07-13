import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  ThemeToggle,
  WallpaperLayer,
  initTheme,
  useAuth,
  useDashboardStore,
  useReadPositionSync,
  useSessionListProvider,
  useSessionProvider,
  useUserPreferencesSync,
  type SessionReviewAcknowledgeResult,
  type SessionSummary,
} from "@seosoyoung/soul-ui";
import { createPageApiClient } from "@seosoyoung/soul-ui/page";
import {
  DASHBOARD_CARD_GAP_PX,
  DASHBOARD_PANEL_GAP_PX,
} from "@seosoyoung/soul-ui/components/dashboard-spacing";
import type { ReviewState } from "@seosoyoung/soul-ui/shared/session-types";

import { useNodes } from "../hooks/useNodes";
import { orchestratorSessionProvider } from "../providers";
import { useOrchestratorStore } from "../store/orchestrator-store";
import { NewTaskForm } from "./NewTaskForm";
import {
  DailyPlannerView,
  ProjectPlannerView,
  type PlannerLoadState,
} from "./PlannerViews";
import { RitualModal } from "./RitualModal";
import { TaskWorkspace } from "./TaskWorkspace";
import { V3Navigation, type PlannerDateNavItem } from "./V3Navigation";
import { BrowserPlannerMutationPort } from "./planner-browser-port";
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
  const [createPending, setCreatePending] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedTaskSnapshot, setSelectedTaskSnapshot] = useState<PlannerTask | null>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [newDocumentOpen, setNewDocumentOpen] = useState(false);
  const [newDocumentTitle, setNewDocumentTitle] = useState("");
  const [sessionDefaults, setSessionDefaults] = useState<PageSessionDefaults | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { initTheme(); }, []);
  const { user } = useAuth();
  useUserPreferencesSync(user?.email ?? null);
  useReadPositionSync();
  useNodes();

  const catalog = useDashboardStore((state) => state.catalog);
  const activeSessionKey = useDashboardStore((state) => state.activeSessionKey);
  const activeSessionSummary = useDashboardStore((state) => state.activeSessionSummary);
  const setActiveSession = useDashboardStore((state) => state.setActiveSession);
  const setActiveSessionSummary = useDashboardStore((state) => state.setActiveSessionSummary);
  const setActiveTab = useDashboardStore((state) => state.setActiveTab);
  const selectFolder = useDashboardStore((state) => state.selectFolder);
  const nodes = useOrchestratorStore((state) => state.nodes);
  const { sessions } = useSessionListProvider({
    intervalMs: 5000,
    enabled: true,
    getSessionProvider: () => orchestratorSessionProvider,
    sessionScope: "all",
  });
  useSessionProvider({
    sessionKey: chatOpen ? activeSessionKey : null,
    getSessionProvider: () => orchestratorSessionProvider,
  });

  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);
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

  const projects = daily.data?.projects ?? [];
  const selectedProject = projects.find((item) => item.id === selectedProjectId) ?? null;
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

  const currentTasks = [...(daily.data?.tasks ?? []), ...(project.data?.tasks ?? [])];
  const selectedTask = currentTasks.find((task) => task.page.id === selectedTaskId) ?? selectedTaskSnapshot;
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

  const returnToPlanner = useCallback(() => {
    setChatOpen(false);
    setWorkspaceOpen(false);
    setSelectedProjectId(null);
    setSelectedDate(today);
  }, [today]);

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
      else if (workspaceOpen) returnToPlanner();
      else if (selectedProjectId) setSelectedProjectId(null);
      else if (selectedDate !== today) setSelectedDate(today);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [createOpen, newDocumentOpen, returnToPlanner, selectedDate, selectedProjectId, today, workspaceOpen]);

  const openTask = (task: PlannerTask) => {
    setSelectedTaskId(task.page.id);
    setSelectedTaskSnapshot(task);
    setWorkspaceOpen(true);
    setChatOpen(false);
  };
  const openSession = useCallback((session: SessionSummary) => {
    setActiveSessionSummary(session);
    setActiveSession(session.agentSessionId);
    setActiveTab("chat");
    setWorkspaceOpen(true);
    setChatOpen(true);
  }, [setActiveSession, setActiveSessionSummary, setActiveTab]);

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
  const openBoard = () => {
    if (!selectedTask) return;
    const projectPage = projects.find((item) => item.id === selectedTask.projectPageId);
    const folderId = projectPage ? resolveProjectFolderId(projectPage, catalog?.folders ?? []) : null;
    if (!folderId) { notify("연결된 v1 보드 폴더를 찾을 수 없습니다"); return; }
    selectFolder(folderId);
    setActiveTab("folder");
    window.history.pushState(null, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
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
  } as CSSProperties;
  const projectTitle = projects.find((item) => item.id === selectedTask?.projectPageId)?.title ?? "미분류";

  return (
    <div className="v3-shell" style={shellStyle}>
      <WallpaperLayer />
      <V3Navigation dates={dates} selectedDate={selectedDate} projects={projects} selectedProjectId={selectedProjectId} onSelectDate={(date) => { setSelectedProjectId(null); setSelectedDate(date); }} onSelectProject={(projectId) => { setSelectedProjectId(projectId); setNewDocumentOpen(false); }} />
      <main className="v3-main">
        <div className="v3-planner">
          <header className="v3-topbar">
            <span className="v3-eyebrow">DAILY PLANNER · PROJECT MOUNTS · RUN CHAT</span><span className="v3-spacer" />
            <button type="button" className="v3-button v3-button--ghost" onClick={() => setRitualOpen(true)}>☀ 아침 정리</button>
            <button type="button" className="v3-button v3-button--primary" onClick={() => setCreateOpen(true)}>＋ 새 업무</button><ThemeToggle />
          </header>
          {createOpen ? <NewTaskForm projects={projects} initialProjectId={selectedProjectId} pending={createPending} onCreate={(title, projectId) => { void createTask(title, projectId); }} onCancel={() => setCreateOpen(false)} /> : null}
          {selectedProject ? (
            <ProjectPlannerView state={project} sessions={sessions} newDocumentOpen={newDocumentOpen} newDocumentTitle={newDocumentTitle} onBack={() => setSelectedProjectId(null)} onOpenTask={openTask} onOpenDocument={(page) => window.location.assign(`/v2/pages/${encodeURIComponent(page.id)}`)} onToggleNewDocument={() => setNewDocumentOpen((value) => !value)} onNewDocumentTitle={setNewDocumentTitle} onCreateDocument={() => { void createDocument(); }} />
          ) : (
            <DailyPlannerView state={daily} selectedDate={selectedDate} reviewSessions={reviewSessions} sessions={sessions} onOpenReview={openSession} onSaveMemo={(blockId, text) => { void saveMemo(blockId, text); }} onOpenProject={setSelectedProjectId} onOpenTask={openTask} />
          )}
        </div>
      </main>
      {workspaceOpen && selectedTask ? (
        <TaskWorkspace task={selectedTask} projectTitle={projectTitle} sessions={sessions} activeSession={activeSession} chatOpen={chatOpen} chatInputDisabled={chatInputDisabled} fileUploadUrl={fileUploadUrl} sessionDefaults={sessionDefaults} onReturnToPlanner={returnToPlanner} onCloseChat={() => setChatOpen(false)} onOpenBoard={openBoard} onOpenSession={openSession} onSaveDescription={saveDescription} onPromoteDocument={promoteDocument} onAcknowledgedReview={acknowledgeReview} />
      ) : null}
      <RitualModal open={ritualOpen} today={today} sessions={sessions} onClose={() => setRitualOpen(false)} onRefresh={() => setRefreshKey((value) => value + 1)} />
      <div className={`v3-toast${toast ? " is-visible" : ""}`} role="status" aria-live="polite">{toast}</div>
    </div>
  );
}

function recentDates(today: string): PlannerDateNavItem[] {
  const base = new Date(`${today}T12:00:00`);
  return [0, 1, 2].map((offset) => {
    const value = new Date(base);
    value.setDate(base.getDate() - offset);
    return { date: dateKey(value), label: offset === 0 ? "오늘" : offset === 1 ? "어제" : new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric", weekday: "short" }).format(value) };
  });
}

function dateKey(value: Date): string {
  return [value.getFullYear(), String(value.getMonth() + 1).padStart(2, "0"), String(value.getDate()).padStart(2, "0")].join("-");
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
