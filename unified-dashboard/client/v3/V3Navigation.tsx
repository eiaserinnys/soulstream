import { useMemo, useRef, useState, type CSSProperties } from "react";
import {
  DashboardIconCap,
  useGlassSurface,
  type CatalogFolder,
} from "@seosoyoung/soul-ui";
import { ChevronsDown, FolderPlus } from "lucide-react";
import { createPageApiClient, type PageDto } from "@seosoyoung/soul-ui/page";

import { flattenProjectFolders } from "./project-folders";
import { setTaskStarred } from "./task-star-actions";
import {
  publishTaskStarChange,
  taskStarredState,
  useTaskStarChanges,
} from "./task-star-store";
import { V3ContextMenu, type V3ContextMenuTarget } from "./V3ContextMenu";
import {
  buildProjectContextMenuActions,
  buildTaskContextMenuActions,
} from "./context-menu-model";
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
  starredTasks,
  starredTasksHasMore,
  starredTasksLoading,
  todayTaskIds,
  completedTaskIds,
  onLoadMoreStarredTasks,
  onSelectDate,
  onSelectFolder,
  onSelectTask,
  onCompleteTask,
  onToggleTaskToday,
  onMoveTaskToProject,
  onCreateProject,
  onCreateTask,
}: {
  dates: readonly PlannerDateNavItem[];
  selectedDate: string;
  folders: readonly CatalogFolder[];
  selectedFolderId: string | null;
  starredTasks: readonly PageDto[];
  starredTasksHasMore: boolean;
  starredTasksLoading: boolean;
  todayTaskIds: ReadonlySet<string>;
  completedTaskIds: ReadonlySet<string>;
  onLoadMoreStarredTasks(): void;
  onSelectDate(date: string): void;
  onSelectFolder(folder: CatalogFolder): void;
  onSelectTask(task: PageDto): void;
  onCompleteTask(task: PageDto): Promise<void>;
  onToggleTaskToday(task: PageDto): Promise<void>;
  onMoveTaskToProject(task: PageDto): void;
  onCreateProject(title: string): Promise<void>;
  onCreateTask(folderId: string): void;
}) {
  const surfaceRef = useRef<HTMLElement>(null);
  const webglActive = useGlassSurface(surfaceRef, { enabled: true });
  const api = useMemo(() => createPageApiClient(), []);
  const taskStarChanges = useTaskStarChanges();
  const projectFolders = useMemo(() => flattenProjectFolders(folders), [folders]);
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
          <DashboardIconCap
            label="별표 업무 더 보기"
            data-testid="v3-load-more-starred-tasks"
            disabled={starredTasksLoading}
            onClick={onLoadMoreStarredTasks}
          >
            <ChevronsDown className="h-4 w-4" aria-hidden="true" />
          </DashboardIconCap>
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
        <DashboardIconCap
          label="새 프로젝트"
          className="v3-new-project-trigger"
          aria-expanded={newProjectOpen}
          onClick={() => { setNewProjectOpen((value) => !value); setError(null); }}
        >
          <FolderPlus className="h-4 w-4" aria-hidden="true" />
        </DashboardIconCap>
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
        actions={contextMenu?.kind === "task" ? buildTaskContextMenuActions({
          starred: taskStarredState(contextMenu.task.id, taskStarChanges, true),
          completed: completedTaskIds.has(contextMenu.task.id),
          inToday: todayTaskIds.has(contextMenu.task.id),
        }, {
          open: () => onSelectTask(contextMenu.task),
          copyId: () => navigator.clipboard.writeText(contextMenu.task.id),
          toggleStar: () => clearTaskStar(contextMenu.task),
          moveToProject: () => onMoveTaskToProject(contextMenu.task),
          complete: () => onCompleteTask(contextMenu.task),
          toggleToday: () => onToggleTaskToday(contextMenu.task),
        }) : contextMenu?.kind === "folder" ? buildProjectContextMenuActions({
          open: () => onSelectFolder(contextMenu.folder),
          copyId: () => navigator.clipboard.writeText(contextMenu.folder.id),
          createTask: () => onCreateTask(contextMenu.folder.id),
        }) : []}
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
