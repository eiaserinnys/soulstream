import { useCallback, useMemo, useRef, useState } from "react";
import {
  Button,
  DashboardIconCap,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
  readFolderTreeExpandedState,
  useGlassSurface,
  writeFolderTreeExpandedState,
  type CatalogFolder,
  type CatalogFolderReorderItem,
} from "@seosoyoung/soul-ui";
import { ChevronsDown, FolderPlus } from "lucide-react";
import { createPageApiClient, type PageDto } from "@seosoyoung/soul-ui/page";

import { ProjectDialog, type ProjectDialogTarget } from "./ProjectDialog";
import { ProjectNavigationTree } from "./ProjectNavigationTree";
import { saveProjectFormContext } from "./project-form-actions";
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
  onRenameProject,
  onDeleteProject,
  onReorderProjects,
  projectHasContents,
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
  onCreateProject(title: string, parentFolderId: string | null): Promise<CatalogFolder>;
  onRenameProject(folder: CatalogFolder, title: string): Promise<void>;
  onDeleteProject(folder: CatalogFolder): Promise<void>;
  onReorderProjects(items: CatalogFolderReorderItem[]): Promise<void>;
  projectHasContents(folderId: string): boolean;
  onCreateTask(folderId: string): void;
}) {
  const surfaceRef = useRef<HTMLElement>(null);
  const webglActive = useGlassSurface(surfaceRef, { enabled: true });
  const api = useMemo(() => createPageApiClient(), []);
  const taskStarChanges = useTaskStarChanges();
  const [projectDialog, setProjectDialog] = useState<ProjectDialogTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CatalogFolder | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<MenuState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const storage = typeof window === "undefined" ? undefined : window.localStorage;
  const isProjectExpanded = useCallback((folderId: string) => (
    expandedFolders[folderId] ?? readFolderTreeExpandedState(storage, folderId)
  ), [expandedFolders, storage]);
  const setProjectExpanded = useCallback((folderId: string, expanded: boolean) => {
    writeFolderTreeExpandedState(storage, folderId, expanded);
    setExpandedFolders((current) => ({ ...current, [folderId]: expanded }));
  }, [storage]);
  const toggleProjectExpanded = useCallback((folderId: string) => {
    setProjectExpanded(folderId, !isProjectExpanded(folderId));
  }, [isProjectExpanded, setProjectExpanded]);

  const reorderProjects = useCallback(async (items: CatalogFolderReorderItem[]) => {
    const moved = items.find((item) => {
      const current = folders.find((folder) => folder.id === item.id);
      return current && (current.parentFolderId ?? null) !== (item.parentFolderId ?? null);
    });
    if (moved?.parentFolderId) setProjectExpanded(moved.parentFolderId, true);
    setError(null);
    try {
      await onReorderProjects(items);
    } catch (cause) {
      setError(`프로젝트 이동 실패 · ${errorText(cause)}`);
    }
  }, [folders, onReorderProjects, setProjectExpanded]);

  const requestDeleteProject = useCallback((folder: CatalogFolder) => {
    if (projectHasContents(folder.id)) setDeleteTarget(folder);
    else void onDeleteProject(folder).catch((cause) => setError(`프로젝트 삭제 실패 · ${errorText(cause)}`));
  }, [onDeleteProject, projectHasContents]);

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
        <ProjectNavigationTree
          folders={folders}
          selectedFolderId={selectedFolderId}
          isExpanded={isProjectExpanded}
          onToggleExpanded={toggleProjectExpanded}
          onSelect={onSelectFolder}
          onContextMenu={(event, folder) => {
            event.preventDefault();
            setContextMenu({ target: { x: event.clientX, y: event.clientY }, kind: "folder", folder });
          }}
          onReorder={reorderProjects}
        />
        {folders.length === 0 ? <p>프로젝트가 없습니다.</p> : null}
        <DashboardIconCap
          label="새 프로젝트"
          className="v3-new-project-trigger"
          aria-expanded={projectDialog?.mode === "create" && projectDialog.parentFolderId === null}
          onClick={() => { setProjectDialog({ mode: "create", parentFolderId: null, parentName: null }); setError(null); }}
        >
          <FolderPlus className="h-4 w-4" aria-hidden="true" />
        </DashboardIconCap>
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
          createProject: () => setProjectDialog({ mode: "create", parentFolderId: null, parentName: null }),
          createChildProject: () => setProjectDialog({ mode: "create", parentFolderId: contextMenu.folder.id, parentName: contextMenu.folder.name }),
          edit: () => setProjectDialog({ mode: "edit", folder: contextMenu.folder }),
          remove: () => requestDeleteProject(contextMenu.folder),
        }) : []}
      />
      <ProjectDialog
        target={projectDialog}
        onClose={() => setProjectDialog(null)}
        onCreateIdentity={onCreateProject}
        onRename={onRenameProject}
        onSaveContext={(pageId, previous, value) => saveProjectFormContext(api, pageId, previous, value)}
        onSaved={(folder) => {
          if (folder.parentFolderId) setProjectExpanded(folder.parentFolderId, true);
        }}
      />
      <Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogPopup className="max-w-sm">
          <DialogHeader>
            <DialogTitle>프로젝트 삭제</DialogTitle>
            <DialogDescription>
              &lsquo;{deleteTarget?.name ?? ""}&rsquo; 프로젝트에는 내용이 있습니다. 프로젝트와 연결 페이지를 함께 보관 처리합니다.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter variant="bare">
            <Button type="button" variant="outline" onClick={() => setDeleteTarget(null)}>취소</Button>
            <Button type="button" variant="destructive" onClick={() => {
              if (!deleteTarget) return;
              const folder = deleteTarget;
              setDeleteTarget(null);
              void onDeleteProject(folder).catch((cause) => setError(`프로젝트 삭제 실패 · ${errorText(cause)}`));
            }}>삭제</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <div className="v3-nav-foot">
        <div><kbd>C</kbd> 새 업무 · <kbd>Esc</kbd> 닫기</div>
      </div>
    </nav>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
