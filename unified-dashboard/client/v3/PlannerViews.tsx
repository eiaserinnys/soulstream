import type { PageDto } from "@seosoyoung/soul-ui/page";
import type { SessionSummary } from "@seosoyoung/soul-ui";

import { DailyMemo } from "./DailyMemo";
import { PlannerTaskCard } from "./PlannerTaskCard";
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
}: {
  state: PlannerLoadState<DailyPlannerData>;
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
    ...data.projects.map((project) => ({
      project,
      tasks: data.tasks.filter((task) => task.projectPageId === project.id),
    })),
    { project: null, tasks: data.tasks.filter((task) => task.projectPageId === null) },
  ].filter((group) => group.tasks.length > 0) : [];

  return (
    <>
      {reviewSessions.length > 0 ? (
        <div className="v3-review-strip">
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
  onOpenDocument(page: PageDto): void;
  onToggleNewDocument(): void;
  onNewDocumentTitle(value: string): void;
  onCreateDocument(): void;
}) {
  const data = state.data;
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
      <section className="v3-documents">
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
          <PlannerTaskCard key={task.page.id} task={task} sessions={sessions} onOpen={() => onOpenTask(task)} />
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

function formatLongDate(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(new Date(`${value}T12:00:00`));
}
