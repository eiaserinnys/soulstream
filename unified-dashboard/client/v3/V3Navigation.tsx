import { useMemo, useRef, useState, type CSSProperties } from "react";
import { useGlassSurface, type CatalogFolder, type SessionSummary } from "@seosoyoung/soul-ui";
import { createPageApiClient, type PageDto } from "@seosoyoung/soul-ui/page";

import { flattenProjectFolders } from "./project-folders";
import { reviewNavigationSessions, reviewSessionTitle } from "./review-queue-model";
import { setTaskStarred } from "./task-star-actions";
import {
  publishTaskStarChange,
  taskStarredState,
  useTaskStarChanges,
} from "./task-star-store";
import { V3ContextMenu, type V3ContextMenuTarget } from "./V3ContextMenu";
import "./v3-project-star.css";

export interface PlannerDateNavItem {
  date: string;
  label: string;
}

type MenuState =
  | { target: V3ContextMenuTarget; kind: "task"; task: PageDto }
  | { target: V3ContextMenuTarget; kind: "folder"; folder: CatalogFolder };

export function V3Navigation({
  dates,
  selectedDate,
  folders,
  selectedFolderId,
  reviewSessions,
  starredTasks,
  starredTasksHasMore,
  starredTasksLoading,
  onLoadMoreStarredTasks,
  onSelectDate,
  onOpenReviewQueue,
  onSelectFolder,
  onSelectTask,
  onCreateProject,
  onCreateTask,
}: {
  dates: readonly PlannerDateNavItem[];
  selectedDate: string;
  folders: readonly CatalogFolder[];
  selectedFolderId: string | null;
  reviewSessions: readonly SessionSummary[];
  starredTasks: readonly PageDto[];
  starredTasksHasMore: boolean;
  starredTasksLoading: boolean;
  onLoadMoreStarredTasks(): void;
  onSelectDate(date: string): void;
  onOpenReviewQueue(): void;
  onSelectFolder(folder: CatalogFolder): void;
  onSelectTask(task: PageDto): void;
  onCreateProject(title: string): Promise<void>;
  onCreateTask(folderId: string): void;
}) {
  const surfaceRef = useRef<HTMLElement>(null);
  const webglActive = useGlassSurface(surfaceRef, { enabled: true });
  const api = useMemo(() => createPageApiClient(), []);
  const taskStarChanges = useTaskStarChanges();
  const projectFolders = useMemo(() => flattenProjectFolders(folders), [folders]);
  const reviewNavigation = useMemo(() => reviewNavigationSessions(reviewSessions), [reviewSessions]);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectTitle, setNewProjectTitle] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<MenuState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const createProject = async () => {
    const title = newProjectTitle.trim();
    if (!title || creatingProject) return;
    setCreatingProject(true);
    setError(null);
    try {
      await onCreateProject(title);
      setNewProjectTitle("");
      setNewProjectOpen(false);
    } catch (cause) {
      setError(`새 프로젝트 생성 실패 · ${errorText(cause)}`);
    } finally {
      setCreatingProject(false);
    }
  };

  const clearTaskStar = async (task: PageDto) => {
    if (pendingTaskId) return;
    setPendingTaskId(task.id);
    setError(null);
    try {
      const updated = await setTaskStarred(api, task.id, false);
      publishTaskStarChange({ page: updated, starred: false });
    } catch (cause) {
      setError(`별표 변경 실패 · ${errorText(cause)}`);
    } finally {
      setPendingTaskId(null);
    }
  };

  return (
    <nav
      ref={surfaceRef}
      className="v3-navigation border border-glass-border glass-strong glass-chrome lg-rim"
      data-liquid-glass-webgl={webglActive ? "true" : undefined}
      aria-label="플래너 내비게이션"
    >
      <div className="v3-navigation-scroll" data-testid="v3-navigation-scroll">
      <h2>데일리</h2>
      <div className="v3-nav-list">
        {dates.map((item) => (
          <button
            type="button"
            key={item.date}
            className={selectedFolderId === null && selectedDate === item.date ? "is-active" : ""}
            onClick={() => onSelectDate(item.date)}
          >
            <span className="v3-emoji" aria-hidden="true">{item.date === dates[0]?.date ? "📅" : ""}</span>
            <span>{item.label}</span>
          </button>
        ))}
      </div>

      <h2>검수 대기</h2>
      <div className="v3-nav-list" data-testid="v3-review-navigation">
        {reviewNavigation.map((session) => (
          <button type="button" className="v3-review-nav-link" key={session.agentSessionId} onClick={onOpenReviewQueue}>
            <span>{reviewSessionTitle(session)}</span>
          </button>
        ))}
        {reviewSessions.length === 0 ? <p>검수 대기가 없습니다.</p> : null}
        {reviewSessions.length > reviewNavigation.length ? (
          <button type="button" className="v3-new-project-trigger" onClick={onOpenReviewQueue}>
            전체 {reviewSessions.length}건 보기
          </button>
        ) : reviewSessions.length > 0 ? (
          <button type="button" className="v3-new-project-trigger" onClick={onOpenReviewQueue}>검수 패널 열기</button>
        ) : null}
      </div>

      <h2>★ 작업</h2>
      <div className="v3-nav-list" data-testid="v3-starred-tasks">
        {starredTasks.map((task) => (
          <button
            type="button"
            key={task.id}
            className="v3-starred-task-link"
            disabled={pendingTaskId === task.id}
            onClick={() => onSelectTask(task)}
            onContextMenu={(event) => {
              event.preventDefault();
              setContextMenu({ target: { x: event.clientX, y: event.clientY }, kind: "task", task });
            }}
          >
            <span aria-hidden="true">★</span><span>{task.title}</span>
          </button>
        ))}
        {starredTasks.length === 0 ? <p>{starredTasksLoading ? "업무를 불러오는 중…" : "별표 업무가 없습니다."}</p> : null}
        {starredTasksHasMore ? (
          <button
            type="button"
            className="v3-new-project-trigger"
            data-testid="v3-load-more-starred-tasks"
            disabled={starredTasksLoading}
            onClick={onLoadMoreStarredTasks}
          >
            {starredTasksLoading ? "불러오는 중…" : "별표 업무 더 보기"}
          </button>
        ) : null}
      </div>

      <h2>전체 프로젝트</h2>
      <div className="v3-nav-list" data-testid="v3-all-projects">
        {projectFolders.map(({ folder, depth }) => (
          <div
            key={folder.id}
            className={`v3-project-nav-row${selectedFolderId === folder.id ? " is-active" : ""}`}
            style={{ "--v3-project-depth": depth } as CSSProperties}
            onContextMenu={(event) => {
              event.preventDefault();
              setContextMenu({ target: { x: event.clientX, y: event.clientY }, kind: "folder", folder });
            }}
          >
            <button
              type="button"
              className={`v3-project-nav-link${selectedFolderId === folder.id ? " is-active" : ""}`}
              aria-level={depth + 1}
              onClick={() => onSelectFolder(folder)}
            >
              <span>{folder.name}</span>
            </button>
          </div>
        ))}
        {projectFolders.length === 0 ? <p>프로젝트가 없습니다.</p> : null}
        <button
          type="button"
          className="v3-new-project-trigger"
          aria-expanded={newProjectOpen}
          onClick={() => { setNewProjectOpen((value) => !value); setError(null); }}
        >
          ＋ 새 프로젝트
        </button>
        {newProjectOpen ? (
          <div className="v3-new-project-form">
            <input
              autoFocus
              value={newProjectTitle}
              placeholder="프로젝트 제목…"
              aria-label="새 프로젝트 제목"
              disabled={creatingProject}
              onChange={(event) => setNewProjectTitle(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void createProject(); }}
            />
            <button type="button" className="v3-button v3-button--primary" disabled={creatingProject || !newProjectTitle.trim()} onClick={() => { void createProject(); }}>
              {creatingProject ? "…" : "만들기"}
            </button>
          </div>
        ) : null}
        {error ? <p className="v3-project-star-error" role="alert">{error}</p> : null}
      </div>
      </div>

      <V3ContextMenu
        target={contextMenu?.target ?? null}
        onClose={() => setContextMenu(null)}
        actions={contextMenu?.kind === "task" ? [
          { label: "업무 열기", onSelect: () => onSelectTask(contextMenu.task) },
          { label: "업무 페이지 ID 복사", onSelect: () => navigator.clipboard.writeText(contextMenu.task.id) },
          {
            label: taskStarredState(contextMenu.task.id, taskStarChanges, true) ? "별표 해제" : "별표 추가",
            onSelect: () => clearTaskStar(contextMenu.task),
            separatorBefore: true,
          },
        ] : contextMenu?.kind === "folder" ? [
          { label: "프로젝트 열기", onSelect: () => onSelectFolder(contextMenu.folder) },
          { label: "폴더 ID 복사", onSelect: () => navigator.clipboard.writeText(contextMenu.folder.id) },
          { label: "새 업무", onSelect: () => onCreateTask(contextMenu.folder.id), separatorBefore: true },
        ] : []}
      />
      <div className="v3-nav-foot">
        <div><kbd>C</kbd> 새 업무 · <kbd>Esc</kbd> 닫기</div>
      </div>
    </nav>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
