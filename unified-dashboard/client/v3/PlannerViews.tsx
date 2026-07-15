import { useEffect, useRef, useState } from "react";
import type { PageDto } from "@seosoyoung/soul-ui/page";
import { useGlassSurface, type SessionSummary } from "@seosoyoung/soul-ui";

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

export type PlannerLoadState<T> =
  | { status: "loading"; data: T | null; message: null }
  | { status: "ready"; data: T; message: null }
  | { status: "error"; data: T | null; message: string };

export function DailyPlannerView({
  state,
  selectedDate,
  sessions,
  onSaveMemo,
  onOpenProject,
  onOpenTask,
  onCompleteTask,
  onToggleTaskToday,
}: {
  state: PlannerLoadState<DailyPlannerData>;
  selectedDate: string;
  sessions: readonly SessionSummary[];
  onSaveMemo(blockId: string | null, text: string): void;
  onOpenProject(projectId: string): void;
  onOpenTask(task: PlannerTask): void;
  onCompleteTask(task: PlannerTask): Promise<void>;
  onToggleTaskToday(task: PlannerTask): Promise<void>;
}) {
  const data = state.data;
  const visibleProjects = data?.projects ?? [];
  const visibleProjectIds = new Set(visibleProjects.map((project) => project.id));
  const groups = data ? [
    ...visibleProjects.map((project) => ({
      project,
      tasks: data.tasks.filter((task) => task.projectPageId === project.id),
    })),
    {
      project: null,
      tasks: data.tasks.filter((task) => (
        task.projectPageId === null || !visibleProjectIds.has(task.projectPageId)
      )),
    },
  ].filter((group) => group.tasks.length > 0) : [];

  return (
    <>
      <div className="v3-date-head">
        <div><span>DAILY</span><h1>{formatLongDate(selectedDate)}</h1></div>
        <p>{state.status === "loading" ? "플래너를 불러오는 중…" : `${data?.tasks.length ?? 0}개의 업무`}</p>
      </div>
      {state.status === "error" ? <LoadError message={state.message} /> : null}
      {data ? <DailyMemo blocks={data.memoBlocks} onSave={onSaveMemo} /> : null}
      <div className="v3-section-head">
        <h2>오늘의 업무</h2><span>{data?.tasks.length ?? 0}개</span>
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
                onOpen={() => onOpenTask(task)}
                onComplete={() => onCompleteTask(task)}
                onToggleToday={() => onToggleTaskToday(task)}
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
  newDocumentOpen,
  newDocumentTitle,
  tasksLoadingMore,
  documentsLoadingMore,
  onLoadMoreTasks,
  onLoadMoreDocuments,
  onBack,
  onOpenTask,
  onCompleteTask,
  onToggleTaskToday,
  onOpenDocument,
  onToggleNewDocument,
  onNewDocumentTitle,
  onCreateDocument,
}: {
  state: PlannerLoadState<ProjectPlannerData>;
  sessions: readonly SessionSummary[];
  newDocumentOpen: boolean;
  newDocumentTitle: string;
  tasksLoadingMore: boolean;
  documentsLoadingMore: boolean;
  onLoadMoreTasks(): void;
  onLoadMoreDocuments(): void;
  onBack(): void;
  onOpenTask(task: PlannerTask): void;
  onCompleteTask(task: PlannerTask): Promise<void>;
  onToggleTaskToday(task: PlannerTask): Promise<void>;
  onOpenDocument(page: PageDto): void;
  onToggleNewDocument(): void;
  onNewDocumentTitle(value: string): void;
  onCreateDocument(): void;
}) {
  const documentSurfaceRef = useRef<HTMLElement>(null);
  const documentWebglActive = useGlassSurface(documentSurfaceRef, { enabled: true });
  const data = state.data;
  const [details, setDetails] = useState<{
    status: "loading" | "ready" | "error";
    data: ProjectPageSnapshot | null;
    message: string | null;
  }>({ status: "loading", data: null, message: null });

  const refreshDetails = async () => {
    if (!data) return;
    const loaded = await fetchProjectPageDetails(data.project.id);
    setDetails({ status: "ready", data: loaded, message: null });
  };
  useEffect(() => {
    let active = true;
    const projectId = data?.project.id;
    if (!projectId) return;
    setDetails({ status: "loading", data: null, message: null });
    void fetchProjectPageDetails(projectId).then((loaded) => {
      if (active) setDetails({ status: "ready", data: loaded, message: null });
    }).catch((error: unknown) => {
      if (active) setDetails({ status: "error", data: null, message: errorText(error) });
    });
    return () => { active = false; };
  }, [data?.project.id]);

  return (
    <>
      <div className="v3-date-head v3-project-title">
        <div>
          <button type="button" className="v3-button v3-button--ghost" onClick={onBack}>← 오늘</button>
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
        <section className="v3-project-context v3-project-star-error" role="alert">{details.message}</section>
      ) : null}
      <section
        ref={documentSurfaceRef}
        className="v3-documents border border-glass-border glass-strong glass-chrome lg-rim"
        data-liquid-glass-webgl={documentWebglActive ? "true" : undefined}
      >
        <div className="v3-section-head">
          <h2><span className="v3-emoji" aria-hidden="true">📄</span> 문서</h2><span>{data?.documents.length ?? 0}개</span>
          <span className="v3-spacer" />
          <button type="button" className="v3-button v3-button--soft" onClick={onToggleNewDocument}>＋ 새 문서</button>
        </div>
        {newDocumentOpen ? (
          <div className="v3-new-document">
            <input
              value={newDocumentTitle}
              placeholder="새 문서 제목…"
              onChange={(event) => onNewDocumentTitle(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") onCreateDocument(); }}
            />
            <button type="button" className="v3-button v3-button--primary" onClick={onCreateDocument}>만들기</button>
          </div>
        ) : null}
        <div className="v3-document-list">
          {data?.documents.map((document) => (
            <button type="button" key={document.id} onClick={() => onOpenDocument(document)}>
              <span><span className="v3-emoji" aria-hidden="true">📄</span> {document.title}</span><small>일반 페이지</small>
            </button>
          ))}
        </div>
        {data?.nextDocumentCursor ? (
          <button
            type="button"
            className="v3-button v3-button--soft"
            data-testid="v3-load-more-project-documents"
            disabled={documentsLoadingMore}
            onClick={onLoadMoreDocuments}
          >
            {documentsLoadingMore ? "문서 불러오는 중…" : "이전 문서 더 보기"}
          </button>
        ) : null}
      </section>
      <div className="v3-section-head"><h2>역대 업무</h2><span>{data?.tasks.length ?? 0}개</span></div>
      <div className="v3-task-list">
        {data?.tasks.map((task) => (
          <PlannerTaskCard
            key={task.page.id}
            task={task}
            sessions={sessions}
            onOpen={() => onOpenTask(task)}
            onComplete={() => onCompleteTask(task)}
            onToggleToday={() => onToggleTaskToday(task)}
          />
        ))}
      </div>
      {data?.nextTaskCursor ? (
        <button
          type="button"
          className="v3-button v3-button--soft"
          data-testid="v3-load-more-project-tasks"
          disabled={tasksLoadingMore}
          onClick={onLoadMoreTasks}
        >
          {tasksLoadingMore ? "업무 불러오는 중…" : "이전 업무 더 보기"}
        </button>
      ) : null}
      {state.status === "ready" && data?.tasks.length === 0 ? (
        <EmptyState text="이 프로젝트에 누적된 업무가 없습니다." />
      ) : null}
    </>
  );
}

export function EmptyProjectPlannerView({ title }: { title: string }) {
  return (
    <section className="v3-load-error" data-testid="v3-empty-project-view">
      <h1>{title}</h1>
      <p>프로젝트 페이지가 비어 있거나 아직 연결되지 않았습니다.</p>
    </section>
  );
}

function LoadError({ message }: { message: string }) {
  return <div className="v3-load-error" role="alert">{message}</div>;
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
