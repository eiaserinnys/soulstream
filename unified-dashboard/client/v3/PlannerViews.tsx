import { useMemo, useRef, useState } from "react";
import { createPageApiClient, type PageDto } from "@seosoyoung/soul-ui/page";
import { useGlassSurface, type SessionSummary } from "@seosoyoung/soul-ui";

import { DailyMemo } from "./DailyMemo";
import { PlannerTaskCard } from "./PlannerTaskCard";
import { setProjectStarred } from "./project-star-actions";
import {
  applyProjectStarChanges,
  projectStarredState,
  publishProjectStarChange,
  useProjectStarChanges,
} from "./project-star-store";
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
  reviewSessions,
  sessions,
  onOpenReview,
  onSaveMemo,
  onOpenProject,
  onOpenTask,
  onCompleteTask,
  onToggleTaskToday,
}: {
  state: PlannerLoadState<DailyPlannerData>;
  selectedDate: string;
  reviewSessions: readonly SessionSummary[];
  sessions: readonly SessionSummary[];
  onOpenReview(session: SessionSummary): void;
  onSaveMemo(blockId: string | null, text: string): void;
  onOpenProject(projectId: string): void;
  onOpenTask(task: PlannerTask): void;
  onCompleteTask(task: PlannerTask): Promise<void>;
  onToggleTaskToday(task: PlannerTask): Promise<void>;
}) {
  const reviewSurfaceRef = useRef<HTMLDivElement>(null);
  const reviewWebglActive = useGlassSurface(reviewSurfaceRef, { enabled: true });
  const data = state.data;
  const starChanges = useProjectStarChanges();
  const visibleProjects = applyProjectStarChanges(data?.projects ?? [], starChanges);
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
      {reviewSessions.length > 0 ? (
        <div
          ref={reviewSurfaceRef}
          className="v3-review-strip border border-glass-border glass-strong glass-chrome lg-rim"
          data-liquid-glass-webgl={reviewWebglActive ? "true" : undefined}
        >
          <strong><span className="v3-emoji" aria-hidden="true">📥</span> 검수 대기 {reviewSessions.length}</strong>
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
  const api = useMemo(() => createPageApiClient(), []);
  const starChanges = useProjectStarChanges();
  const starred = data ? projectStarredState(data.project.id, starChanges) : true;
  const [starPending, setStarPending] = useState(false);
  const [starMessage, setStarMessage] = useState<string | null>(null);

  const toggleProjectStar = async () => {
    if (!data || starPending) return;
    const next = !starred;
    if (!next && !window.confirm(`“${data.project.title}” 프로젝트의 별표를 해제할까요?\n내비게이션에서 제거됩니다.`)) return;
    setStarPending(true);
    setStarMessage(null);
    try {
      const updated = await setProjectStarred(api, data.project.id, next);
      publishProjectStarChange({ page: updated, starred: next });
      setStarMessage(next ? "프로젝트 별표를 다시 켰습니다." : "별표를 해제해 내비게이션에서 제거했습니다.");
    } catch (cause) {
      setStarMessage(`별표 변경 실패 · ${errorText(cause)}`);
    } finally {
      setStarPending(false);
    }
  };

  return (
    <>
      <div className="v3-date-head v3-project-title">
        <div>
          <button type="button" className="v3-button v3-button--ghost" onClick={onBack}>← 오늘</button>
          <h1>{data?.project.title ?? "프로젝트"}</h1>
          <button
            type="button"
            className={`v3-button v3-project-header-star ${starred ? "v3-button--soft" : "v3-button--ghost"}`}
            aria-pressed={starred}
            disabled={!data || starPending}
            onClick={() => { void toggleProjectStar(); }}
          >
            {starred ? "★ 별표됨" : "☆ 별표하기"}
          </button>
        </div>
        <p className={starMessage?.includes("실패") ? "v3-project-star-error" : undefined}>
          {starMessage ?? "프로젝트에 누적된 업무와 문서 · 최근순"}
        </p>
      </div>
      {state.status === "error" ? <LoadError message={state.message} /> : null}
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
      {state.status === "ready" && data?.tasks.length === 0 ? (
        <EmptyState text="이 프로젝트에 누적된 업무가 없습니다." />
      ) : null}
    </>
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
