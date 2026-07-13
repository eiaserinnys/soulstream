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
  useSessionListProvider,
  useUserPreferencesSync,
  type SessionSummary,
} from "@seosoyoung/soul-ui";
import {
  createPageApiClient,
  type PageDto,
} from "@seosoyoung/soul-ui/page";
import {
  DASHBOARD_CARD_GAP_PX,
  DASHBOARD_PANEL_GAP_PX,
} from "@seosoyoung/soul-ui/components/dashboard-spacing";
import type { ReviewState } from "@seosoyoung/soul-ui/shared/session-types";

import { orchestratorSessionProvider } from "../providers";
import { DailyMemo } from "./DailyMemo";
import { NewTaskForm } from "./NewTaskForm";
import { PlannerTaskCard } from "./PlannerTaskCard";
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
import "./v3-planner.css";
import "./v3-planner-surfaces.css";

type LoadState<T> =
  | { status: "loading"; data: T | null; message: null }
  | { status: "ready"; data: T; message: null }
  | { status: "error"; data: T | null; message: string };

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
  const [daily, setDaily] = useState<LoadState<DailyPlannerData>>({ status: "loading", data: null, message: null });
  const [project, setProject] = useState<LoadState<ProjectPlannerData>>({ status: "loading", data: null, message: null });
  const [refreshKey, setRefreshKey] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [createPending, setCreatePending] = useState(false);
  const [selectedTask, setSelectedTask] = useState<PlannerTask | null>(null);
  const [newDocumentOpen, setNewDocumentOpen] = useState(false);
  const [newDocumentTitle, setNewDocumentTitle] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { initTheme(); }, []);
  const { user } = useAuth();
  useUserPreferencesSync(user?.email ?? null);
  const catalog = useDashboardStore((state) => state.catalog);
  const { sessions } = useSessionListProvider({
    intervalMs: 5000,
    enabled: true,
    getSessionProvider: () => orchestratorSessionProvider,
    sessionScope: "all",
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
      else if (selectedTask) setSelectedTask(null);
      else if (selectedProjectId) setSelectedProjectId(null);
      else if (selectedDate !== today) setSelectedDate(today);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [createOpen, newDocumentOpen, selectedDate, selectedProjectId, selectedTask, today]);

  const reviewSessions = sessions.filter((session) => session.reviewState === NEEDS_REVIEW);
  const createTask = async (title: string, projectId: string) => {
    const projectPage = projects.find((item) => item.id === projectId);
    if (!projectPage) { notify("선택한 프로젝트를 찾을 수 없습니다"); return; }
    const folderId = resolveProjectFolderId(projectPage, catalog?.folders ?? []);
    if (!folderId) {
      notify("프로젝트 페이지에 런북 저장 폴더를 연결해야 합니다");
      return;
    }
    setCreatePending(true);
    try {
      const dailyPage = selectedDate === today && daily.data
        ? daily.data.daily.page
        : (await api.getDailyPage(today)).page;
      await createPlannerTask({
        title,
        dailyPageId: dailyPage.id,
        projectPageId: projectPage.id,
        folderId,
      }, mutationPort);
      setCreateOpen(false);
      setSelectedProjectId(null);
      setSelectedDate(today);
      setRefreshKey((value) => value + 1);
      notify(`새 업무 생성 · ${title}`);
    } catch (error) {
      const label = error instanceof PlannerTaskCreationError
        ? CREATION_ERROR_LABEL[error.phase]
        : "새 업무 생성";
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
    } catch (error) {
      notify(`오늘 메모 저장 실패 · ${errorText(error)}`);
    }
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
    } catch (error) {
      notify(`새 문서 생성 실패 · ${errorText(error)}`);
    }
  };

  const shellStyle = {
    "--v3-card-gap": `${DASHBOARD_CARD_GAP_PX}px`,
    "--v3-panel-gap": `${DASHBOARD_PANEL_GAP_PX}px`,
  } as CSSProperties;

  return (
    <div className="v3-shell" style={shellStyle}>
      <WallpaperLayer />
      <V3Navigation
        dates={dates}
        selectedDate={selectedDate}
        projects={projects}
        selectedProjectId={selectedProjectId}
        onSelectDate={(date) => { setSelectedProjectId(null); setSelectedDate(date); }}
        onSelectProject={(projectId) => { setSelectedProjectId(projectId); setNewDocumentOpen(false); }}
      />
      <main className="v3-main">
        <div className="v3-planner">
          <header className="v3-topbar">
            <span className="v3-eyebrow">DAILY PLANNER · PROJECT MOUNTS · RUN CHAT</span>
            <span className="v3-spacer" />
            <button type="button" className="v3-button v3-button--primary" onClick={() => setCreateOpen(true)}>＋ 새 업무</button>
            <ThemeToggle />
          </header>
          {createOpen ? (
            <NewTaskForm
              projects={projects}
              initialProjectId={selectedProjectId}
              pending={createPending}
              onCreate={(title, projectId) => { void createTask(title, projectId); }}
              onCancel={() => setCreateOpen(false)}
            />
          ) : null}
          {selectedProject ? (
            <ProjectView
              state={project}
              sessions={sessions}
              newDocumentOpen={newDocumentOpen}
              newDocumentTitle={newDocumentTitle}
              onBack={() => setSelectedProjectId(null)}
              onOpenTask={setSelectedTask}
              onOpenDocument={(page) => window.location.assign(`/v2/pages/${encodeURIComponent(page.id)}`)}
              onToggleNewDocument={() => setNewDocumentOpen((value) => !value)}
              onNewDocumentTitle={setNewDocumentTitle}
              onCreateDocument={() => { void createDocument(); }}
            />
          ) : (
            <DailyView
              state={daily}
              selectedDate={selectedDate}
              reviewSessions={reviewSessions}
              sessions={sessions}
              onOpenReview={(session) => window.location.assign(`/#${encodeURIComponent(session.agentSessionId)}`)}
              onSaveMemo={(blockId, text) => { void saveMemo(blockId, text); }}
              onOpenProject={setSelectedProjectId}
              onOpenTask={setSelectedTask}
            />
          )}
        </div>
      </main>
      {selectedTask ? <TaskPlaceholder task={selectedTask} onClose={() => setSelectedTask(null)} /> : null}
      <div className={`v3-toast${toast ? " is-visible" : ""}`} role="status" aria-live="polite">{toast}</div>
    </div>
  );
}

function DailyView({
  state,
  selectedDate,
  reviewSessions,
  sessions,
  onOpenReview,
  onSaveMemo,
  onOpenProject,
  onOpenTask,
}: {
  state: LoadState<DailyPlannerData>;
  selectedDate: string;
  reviewSessions: readonly SessionSummary[];
  sessions: readonly SessionSummary[];
  onOpenReview(session: SessionSummary): void;
  onSaveMemo(blockId: string | null, text: string): void;
  onOpenProject(projectId: string): void;
  onOpenTask(task: PlannerTask): void;
}) {
  const data = state.data;
  const groups = data ? [
    ...data.projects.map((project) => ({ project, tasks: data.tasks.filter((task) => task.projectPageId === project.id) })),
    { project: null, tasks: data.tasks.filter((task) => task.projectPageId === null) },
  ].filter((group) => group.tasks.length > 0) : [];
  return (
    <>
      {reviewSessions.length > 0 ? (
        <div className="v3-review-strip">
          <strong>📥 검수 대기 {reviewSessions.length}</strong>
          {reviewSessions.map((session) => (
            <button type="button" key={session.agentSessionId} onClick={() => onOpenReview(session)}>
              {session.displayName ?? session.prompt ?? session.agentSessionId}
            </button>
          ))}
        </div>
      ) : null}
      <div className="v3-date-head">
        <div><span>DAILY</span><h1>{formatLongDate(selectedDate)}</h1></div>
        <p>{state.status === "loading" ? "플래너를 불러오는 중…" : `${data?.tasks.length ?? 0}개의 업무`}</p>
      </div>
      {state.status === "error" ? <LoadError message={state.message} /> : null}
      {data ? <DailyMemo blocks={data.memoBlocks} onSave={onSaveMemo} /> : null}
      <div className="v3-section-head"><h2>오늘의 업무</h2><span>{data?.tasks.length ?? 0}개</span><span className="v3-spacer" /><small><kbd>C</kbd> 새 업무</small></div>
      {groups.map((group) => (
        <section className="v3-project-group" key={group.project?.id ?? "unclassified"}>
          <div className="v3-project-head">
            <h3>{group.project?.title ?? "미분류"}</h3><span>{group.tasks.length}개</span>
            {group.project ? <button type="button" onClick={() => onOpenProject(group.project!.id)}>아카이브 보기 ›</button> : null}
          </div>
          <div className="v3-task-list">
            {group.tasks.map((task) => <PlannerTaskCard key={task.page.id} task={task} sessions={sessions} onOpen={() => onOpenTask(task)} />)}
          </div>
        </section>
      ))}
      {state.status === "ready" && groups.length === 0 ? <EmptyState text="이 날짜에 편입된 업무가 없습니다." /> : null}
    </>
  );
}

function ProjectView({
  state,
  sessions,
  newDocumentOpen,
  newDocumentTitle,
  onBack,
  onOpenTask,
  onOpenDocument,
  onToggleNewDocument,
  onNewDocumentTitle,
  onCreateDocument,
}: {
  state: LoadState<ProjectPlannerData>;
  sessions: readonly SessionSummary[];
  newDocumentOpen: boolean;
  newDocumentTitle: string;
  onBack(): void;
  onOpenTask(task: PlannerTask): void;
  onOpenDocument(page: PageDto): void;
  onToggleNewDocument(): void;
  onNewDocumentTitle(value: string): void;
  onCreateDocument(): void;
}) {
  const data = state.data;
  return (
    <>
      <div className="v3-date-head v3-project-title">
        <div><button type="button" className="v3-button v3-button--ghost" onClick={onBack}>← 오늘</button><h1>{data?.project.title ?? "프로젝트"}</h1></div>
        <p>프로젝트에 누적된 업무와 문서 · 최근순</p>
      </div>
      {state.status === "error" ? <LoadError message={state.message} /> : null}
      <section className="v3-documents">
        <div className="v3-section-head"><h2>📄 문서</h2><span>{data?.documents.length ?? 0}개</span><span className="v3-spacer" /><button type="button" className="v3-button v3-button--soft" onClick={onToggleNewDocument}>＋ 새 문서</button></div>
        {newDocumentOpen ? (
          <div className="v3-new-document">
            <input value={newDocumentTitle} placeholder="새 문서 제목…" onChange={(event) => onNewDocumentTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onCreateDocument(); }} />
            <button type="button" className="v3-button v3-button--primary" onClick={onCreateDocument}>만들기</button>
          </div>
        ) : null}
        <div className="v3-document-list">
          {data?.documents.map((document) => <button type="button" key={document.id} onClick={() => onOpenDocument(document)}><span>📄 {document.title}</span><small>일반 페이지</small></button>)}
        </div>
      </section>
      <div className="v3-section-head"><h2>역대 업무</h2><span>{data?.tasks.length ?? 0}개</span></div>
      <div className="v3-task-list">
        {data?.tasks.map((task) => <PlannerTaskCard key={task.page.id} task={task} sessions={sessions} onOpen={() => onOpenTask(task)} />)}
      </div>
      {state.status === "ready" && data?.tasks.length === 0 ? <EmptyState text="이 프로젝트에 누적된 업무가 없습니다." /> : null}
    </>
  );
}

function TaskPlaceholder({ task, onClose }: { task: PlannerTask; onClose(): void }) {
  return (
    <div className="v3-detail-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="v3-detail-placeholder" aria-label="업무 상세 자리표시">
        <div><span>업무 상세</span><button type="button" aria-label="닫기" onClick={onClose}>×</button></div>
        <h2>{task.page.title}</h2>
        <p>업무 페이지와 런북이 연결되어 있습니다.</p>
        <div className="v3-placeholder-card"><strong>다음 단계에서 열립니다</strong><span>마크다운 업무 본문 · 컨텍스트 슬롯 · Run 히스토리 · 채팅 워크스페이스</span></div>
      </aside>
    </div>
  );
}

function LoadError({ message }: { message: string }) {
  return <div className="v3-load-error" role="alert">{message}</div>;
}

function EmptyState({ text }: { text: string }) {
  return <div className="v3-empty">{text}</div>;
}

function recentDates(today: string): PlannerDateNavItem[] {
  const base = new Date(`${today}T12:00:00`);
  return [0, 1, 2].map((offset) => {
    const value = new Date(base);
    value.setDate(base.getDate() - offset);
    return { date: dateKey(value), label: offset === 0 ? "오늘" : offset === 1 ? "어제" : shortDate(value) };
  });
}

function dateKey(value: Date): string {
  return [value.getFullYear(), String(value.getMonth() + 1).padStart(2, "0"), String(value.getDate()).padStart(2, "0")].join("-");
}

function shortDate(value: Date): string {
  return new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric", weekday: "short" }).format(value);
}

function formatLongDate(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric", weekday: "long" }).format(new Date(`${value}T12:00:00`));
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
