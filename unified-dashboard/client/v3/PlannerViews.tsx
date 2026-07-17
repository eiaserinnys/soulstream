import { useEffect, useRef, useState } from "react";
import type { PageDto } from "@seosoyoung/soul-ui/page";
import { Button, DashboardIconCap, retainEqualValue, useGlassSurface, type SessionSummary } from "@seosoyoung/soul-ui";
import { ArrowLeft, ChevronsDown, FilePlus2 } from "lucide-react";

import { DailyMemo } from "./DailyMemo";
import { PlannerTaskCard } from "./PlannerTaskCard";
import {
  fetchProjectPageDetails,
  type ProjectPageSnapshot,
} from "./project-page-details";
import { ProjectContextEditor } from "./ProjectContextEditor";
import type {
  DailyPlannerData,
  PlannerTask,
  ProjectPlannerData,
} from "./planner-data";
import { visibleDailyTasks } from "./today-task-state";
import { V3ErrorNotice } from "./V3ErrorNotice";
import { V3ContextMenu, type V3ContextMenuTarget } from "./V3ContextMenu";
import { buildDocumentContextMenuActions } from "./context-menu-model";
import { loadConfirmedResult } from "./planner-query-state";
import type { SessionNodeConnectivity } from "./session-node-connectivity";

export type PlannerLoadState<T> =
  | { status: "loading"; data: T | null; message: null }
  | { status: "ready"; data: T; message: null }
  | { status: "error"; data: T | null; message: string };

export function DailyPlannerView({
  state,
  selectedDate,
  isTodayView,
  todayTaskIds,
  sessions,
  nodeConnectivity,
  onSaveMemo,
  onOpenProject,
  onOpenTask,
  onCompleteTask,
  onToggleTaskToday,
  onMoveTaskToProject,
}: {
  state: PlannerLoadState<DailyPlannerData>;
  selectedDate: string;
  isTodayView: boolean;
  todayTaskIds: ReadonlySet<string>;
  sessions: readonly SessionSummary[];
  nodeConnectivity: SessionNodeConnectivity;
  onSaveMemo(blockId: string | null, text: string): Promise<void>;
  onOpenProject(projectId: string): void;
  onOpenTask(task: PlannerTask): void;
  onCompleteTask(task: PlannerTask): Promise<void>;
  onToggleTaskToday(task: PlannerTask): Promise<void>;
  onMoveTaskToProject(task: PlannerTask): void;
}) {
  const data = state.data;
  const visibleTasks = visibleDailyTasks(data?.tasks ?? [], isTodayView, todayTaskIds);
  const visibleProjects = data?.projects ?? [];
  const visibleProjectIds = new Set(visibleProjects.map((project) => project.id));
  const groups = data ? [
    ...visibleProjects.map((project) => ({
      project,
      tasks: visibleTasks.filter((task) => task.projectPageId === project.id),
    })),
    {
      project: null,
      tasks: visibleTasks.filter((task) => (
        task.projectPageId === null || !visibleProjectIds.has(task.projectPageId)
      )),
    },
  ].filter((group) => group.tasks.length > 0) : [];

  return (
    <>
      <div className="v3-date-head">
        <div><span>DAILY</span><h1>{formatLongDate(selectedDate)}</h1></div>
        <p>{state.status === "loading" ? "플래너를 불러오는 중…" : `${visibleTasks.length}개의 업무`}</p>
      </div>
      {state.status === "error" ? <LoadError message={state.message} /> : null}
      {data ? <DailyMemo blocks={data.memoBlocks} onSave={onSaveMemo} /> : null}
      <div className="v3-section-head">
        <h2>오늘의 업무</h2><span>{visibleTasks.length}개</span>
        <span className="v3-spacer" /><small><kbd>C</kbd> 새 업무</small>
      </div>
      {groups.map((group) => (
        <section className="v3-project-group" key={group.project?.id ?? "unclassified"}>
          <div className="v3-project-head">
            <h3>{group.project?.title ?? "미분류"}</h3><span>{group.tasks.length}개</span>
            {group.project ? (
              <button type="button" onClick={() => onOpenProject(group.project!.id)}>아카이브 보기 ›</button>
            ) : null}
          </div>
          <div className="v3-task-list">
            {group.tasks.map((task) => (
              <PlannerTaskCard
                key={task.page.id}
                task={task}
                sessions={sessions}
                nodeConnectivity={nodeConnectivity}
                isInToday={todayTaskIds.has(task.page.id)}
                onOpen={() => onOpenTask(task)}
                onComplete={() => onCompleteTask(task)}
                onToggleToday={() => onToggleTaskToday(task)}
                onMoveToProject={() => onMoveTaskToProject(task)}
              />
            ))}
          </div>
        </section>
      ))}
      {state.status === "ready" && groups.length === 0 ? (
        <EmptyState text="이 날짜에 편입된 업무가 없습니다." />
      ) : null}
    </>
  );
}

export function ProjectPlannerView({
  state,
  sessions,
  nodeConnectivity,
  todayTaskIds,
  newDocumentOpen,
  newDocumentTitle,
  tasksLoadingMore,
  documentsLoadingMore,
  invalidationKey,
  onLoadMoreTasks,
  onLoadMoreDocuments,
  onBack,
  onOpenTask,
  onCompleteTask,
  onToggleTaskToday,
  onMoveTaskToProject,
  onOpenDocument,
  onToggleNewDocument,
  onNewDocumentTitle,
  onCreateDocument,
}: {
  state: PlannerLoadState<ProjectPlannerData>;
  sessions: readonly SessionSummary[];
  nodeConnectivity: SessionNodeConnectivity;
  todayTaskIds: ReadonlySet<string>;
  newDocumentOpen: boolean;
  newDocumentTitle: string;
  tasksLoadingMore: boolean;
  documentsLoadingMore: boolean;
  invalidationKey: number;
  onLoadMoreTasks(): void;
  onLoadMoreDocuments(): void;
  onBack(): void;
  onOpenTask(task: PlannerTask): void;
  onCompleteTask(task: PlannerTask): Promise<void>;
  onToggleTaskToday(task: PlannerTask): Promise<void>;
  onMoveTaskToProject(task: PlannerTask): void;
  onOpenDocument(page: PageDto): void;
  onToggleNewDocument(): void;
  onNewDocumentTitle(value: string): void;
  onCreateDocument(): void;
}) {
  const documentSurfaceRef = useRef<HTMLElement>(null);
  const documentWebglActive = useGlassSurface(documentSurfaceRef, { enabled: true });
  const data = state.data;
  const [documentMenu, setDocumentMenu] = useState<{ target: V3ContextMenuTarget; page: PageDto } | null>(null);
  const [details, setDetails] = useState<{
    status: "loading" | "ready" | "error";
    data: ProjectPageSnapshot | null;
    message: string | null;
  }>({ status: "loading", data: null, message: null });

  const refreshDetails = async () => {
    if (!data) return;
    const loaded = await loadConfirmedResult({
      previous: details.data,
      load: () => fetchProjectPageDetails(data.project.id),
      clearsVisibleContent: (current, next) => current.blocks.length > 0 && next.blocks.length === 0,
    });
    setDetails((current) => retainEqualValue(current, { status: "ready", data: loaded, message: null }));
  };
  useEffect(() => {
    let active = true;
    const projectId = data?.project.id;
    if (!projectId) return;
    const previous = details.data?.page.id === projectId ? details.data : null;
    setDetails((current) => current.data?.page.id === projectId
      ? current
      : { status: "loading", data: null, message: null });
    void loadConfirmedResult({
      previous,
      load: () => fetchProjectPageDetails(projectId),
      clearsVisibleContent: (current, next) => current.blocks.length > 0 && next.blocks.length === 0,
    }).then((loaded) => {
      if (active) {
        setDetails((current) => retainEqualValue(current, { status: "ready", data: loaded, message: null }));
      }
    }).catch((error: unknown) => {
      console.error("[v3/planner] 프로젝트 컨텍스트 조회 실패", error);
      if (active) {
        setDetails((current) => retainEqualValue(current, {
          status: "error",
          data: current.data,
          message: errorText(error),
        }));
      }
    });
    return () => { active = false; };
  }, [data?.project.id, invalidationKey]);

  return (
    <>
      <div className="v3-date-head v3-project-title">
        <div>
          <DashboardIconCap label="오늘로 돌아가기" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          </DashboardIconCap>
          <h1>{data?.project.title ?? "프로젝트"}</h1>
        </div>
        <p>프로젝트에 누적된 업무와 문서 · 최근순</p>
      </div>
      {state.status === "error" ? <LoadError message={state.message} /> : null}
      {data && details.status === "ready" && details.data ? (
        <ProjectContextEditor pageId={data.project.id} snapshot={details.data} onChanged={refreshDetails} />
      ) : details.status === "loading" ? (
        <section className="v3-project-context" aria-busy="true">프로젝트 컨텍스트를 불러오는 중…</section>
      ) : details.status === "error" ? (
        <V3ErrorNotice
          className="v3-project-context v3-project-star-error"
          message="프로젝트 컨텍스트를 불러오지 못했습니다."
          detail={details.message}
        />
      ) : null}
      <section
        ref={documentSurfaceRef}
        className="v3-documents border border-glass-border glass-strong glass-chrome lg-rim"
        data-liquid-glass-webgl={documentWebglActive ? "true" : undefined}
      >
        <div className="v3-section-head">
          <h2><span className="v3-emoji" aria-hidden="true">📄</span> 문서</h2><span>{data?.documents.length ?? 0}개</span>
          <span className="v3-spacer" />
          <DashboardIconCap label="새 문서" aria-expanded={newDocumentOpen} onClick={onToggleNewDocument}>
            <FilePlus2 className="h-4 w-4" aria-hidden="true" />
          </DashboardIconCap>
        </div>
        {newDocumentOpen ? (
          <div className="v3-new-document">
            <input
              value={newDocumentTitle}
              placeholder="새 문서 제목…"
              onChange={(event) => onNewDocumentTitle(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") onCreateDocument(); }}
            />
            <Button onClick={onCreateDocument}>만들기</Button>
          </div>
        ) : null}
        <div className="v3-document-list">
          {data?.documents.map((document) => (
            <button
              type="button"
              key={document.id}
              onClick={() => onOpenDocument(document)}
              onContextMenu={(event) => {
                event.preventDefault();
                setDocumentMenu({ target: { x: event.clientX, y: event.clientY }, page: document });
              }}
            >
              <span><span className="v3-emoji" aria-hidden="true">📄</span> {document.title}</span><small>일반 페이지</small>
            </button>
          ))}
        </div>
        <V3ContextMenu
          target={documentMenu?.target ?? null}
          onClose={() => setDocumentMenu(null)}
          actions={documentMenu ? buildDocumentContextMenuActions({
            open: () => onOpenDocument(documentMenu.page),
            copyId: () => navigator.clipboard.writeText(documentMenu.page.id),
          }) : []}
        />
        {data?.nextDocumentCursor ? (
          <DashboardIconCap
            label="이전 문서 더 보기"
            data-testid="v3-load-more-project-documents"
            disabled={documentsLoadingMore}
            onClick={onLoadMoreDocuments}
          >
            <ChevronsDown className="h-4 w-4" aria-hidden="true" />
          </DashboardIconCap>
        ) : null}
      </section>
      <div className="v3-section-head"><h2>역대 업무</h2><span>{data?.tasks.length ?? 0}개</span></div>
      <div className="v3-task-list">
        {data?.tasks.map((task) => (
          <PlannerTaskCard
            key={task.page.id}
            task={task}
            sessions={sessions}
            nodeConnectivity={nodeConnectivity}
            isInToday={todayTaskIds.has(task.page.id)}
            onOpen={() => onOpenTask(task)}
            onComplete={() => onCompleteTask(task)}
            onToggleToday={() => onToggleTaskToday(task)}
            onMoveToProject={() => onMoveTaskToProject(task)}
          />
        ))}
      </div>
      {data?.nextTaskCursor ? (
        <DashboardIconCap
          label="이전 업무 더 보기"
          data-testid="v3-load-more-project-tasks"
          disabled={tasksLoadingMore}
          onClick={onLoadMoreTasks}
        >
          <ChevronsDown className="h-4 w-4" aria-hidden="true" />
        </DashboardIconCap>
      ) : null}
      {state.status === "ready" && data?.tasks.length === 0 ? (
        <EmptyState text="이 프로젝트에 누적된 업무가 없습니다." />
      ) : null}
    </>
  );
}

function LoadError({ message }: { message: string }) {
  return (
    <V3ErrorNotice
      className="v3-load-error"
      message="플래너를 불러오지 못했습니다."
      detail={message}
    />
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="v3-empty">{text}</div>;
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function formatLongDate(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(new Date(`${value}T12:00:00`));
}
