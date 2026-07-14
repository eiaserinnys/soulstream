import { useMemo, useRef, useState } from "react";
import { useGlassSurface } from "@seosoyoung/soul-ui";
import { createPageApiClient, type PageDto } from "@seosoyoung/soul-ui/page";

import { createStarredProject, renameProjectPage, setProjectStarred } from "./project-star-actions";
import {
  applyAllProjectChanges,
  applyProjectStarChanges,
  projectStarredState,
  publishProjectStarChange,
  useProjectStarChanges,
} from "./project-star-store";
import { V3ContextMenu, type V3ContextMenuTarget } from "./V3ContextMenu";
import "./v3-project-star.css";

export interface PlannerDateNavItem {
  date: string;
  label: string;
}

type ProjectListKind = "starred" | "all";

export function V3Navigation({
  dates,
  selectedDate,
  projects,
  selectedProjectId,
  projectIndexHasMore,
  projectIndexLoading,
  onLoadMoreProjects,
  onSelectDate,
  onSelectProject,
  onCreateTask,
}: {
  dates: readonly PlannerDateNavItem[];
  selectedDate: string;
  projects: readonly PageDto[];
  selectedProjectId: string | null;
  projectIndexHasMore: boolean;
  projectIndexLoading: boolean;
  onLoadMoreProjects(): void;
  onSelectDate(date: string): void;
  onSelectProject(projectId: string): void;
  onCreateTask(projectId: string): void;
}) {
  const surfaceRef = useRef<HTMLElement>(null);
  const webglActive = useGlassSurface(surfaceRef, { enabled: true });
  const api = useMemo(() => createPageApiClient(), []);
  const starChanges = useProjectStarChanges();
  const allProjects = applyAllProjectChanges(projects, starChanges)
    .filter((project) => !project.daily_date && !project.archived);
  const starredProjects = applyProjectStarChanges(
    projects.filter((project) => project.metadata.starred === true),
    starChanges,
  );
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectTitle, setNewProjectTitle] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [pendingStarId, setPendingStarId] = useState<string | null>(null);
  const [editingRow, setEditingRow] = useState<{ key: string; project: PageDto; title: string } | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    target: V3ContextMenuTarget;
    project: PageDto;
    listKind: ProjectListKind;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const createProject = async () => {
    const title = newProjectTitle.trim();
    if (!title || creatingProject) return;
    setCreatingProject(true);
    setError(null);
    try {
      const project = await createStarredProject(api, { title, date: selectedDate });
      publishProjectStarChange({ page: project, starred: true });
      setNewProjectTitle("");
      setNewProjectOpen(false);
    } catch (cause) {
      setError(`새 프로젝트 생성 실패 · ${errorText(cause)}`);
    } finally {
      setCreatingProject(false);
    }
  };

  const toggleProjectStar = async (project: PageDto) => {
    if (pendingStarId) return;
    const starred = isProjectStarred(project, starChanges);
    if (starred && !window.confirm(`“${project.title}” 프로젝트를 ★ 작업에서 숨길까요?\n전체 프로젝트에는 계속 남습니다.`)) return;
    setPendingStarId(project.id);
    setError(null);
    try {
      const updated = await setProjectStarred(api, project.id, !starred);
      publishProjectStarChange({ page: updated, starred: !starred });
    } catch (cause) {
      setError(`별표 변경 실패 · ${errorText(cause)}`);
    } finally {
      setPendingStarId(null);
    }
  };

  const startRename = (project: PageDto, listKind: ProjectListKind) => {
    setEditingRow({ key: `${listKind}:${project.id}`, project, title: project.title });
    setError(null);
  };

  const commitRename = async () => {
    if (!editingRow) return;
    const current = editingRow;
    const title = current.title.trim();
    setEditingRow(null);
    if (!title || title === current.project.title) return;
    setError(null);
    try {
      const updated = await renameProjectPage(api, current.project.id, title);
      publishProjectStarChange({
        page: updated,
        starred: isProjectStarred(current.project, starChanges),
      });
    } catch (cause) {
      setError(`프로젝트 이름 변경 실패 · ${errorText(cause)}`);
    }
  };

  const renderProject = (project: PageDto, listKind: ProjectListKind) => {
    const rowKey = `${listKind}:${project.id}`;
    const editing = editingRow?.key === rowKey;
    const starred = isProjectStarred(project, starChanges);
    return (
      <div
        key={project.id}
        className={`v3-project-nav-row${selectedProjectId === project.id ? " is-active" : ""}`}
        onContextMenu={(event) => {
          event.preventDefault();
          setContextMenu({ target: { x: event.clientX, y: event.clientY }, project, listKind });
        }}
      >
        {editing ? (
          <input
            autoFocus
            className="v3-project-rename-input"
            aria-label={`${project.title} 이름 변경`}
            value={editingRow.title}
            onChange={(event) => setEditingRow({ ...editingRow, title: event.target.value })}
            onBlur={() => { void commitRename(); }}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); void commitRename(); }
              if (event.key === "Escape") { event.preventDefault(); setEditingRow(null); }
            }}
          />
        ) : (
          <button
            type="button"
            className={`v3-project-nav-link${selectedProjectId === project.id ? " is-active" : ""}`}
            onClick={() => onSelectProject(project.id)}
            onDoubleClick={() => startRename(project, listKind)}
          >
            <span className="v3-project-bullet" aria-hidden="true">◆</span>
            <span>{project.title}</span>
          </button>
        )}
        <button
          type="button"
          className="v3-project-star-toggle"
          aria-label={`${project.title} ${starred ? "별표 해제" : "별표 추가"}`}
          title={starred ? "★ 작업에서 숨기기" : "★ 작업에 추가"}
          disabled={pendingStarId === project.id}
          onClick={() => { void toggleProjectStar(project); }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          {starred ? "★" : "☆"}
        </button>
      </div>
    );
  };

  return (
    <nav
      ref={surfaceRef}
      className="v3-navigation border border-glass-border glass-strong glass-chrome lg-rim"
      data-liquid-glass-webgl={webglActive ? "true" : undefined}
      aria-label="플래너 내비게이션"
    >
      <h2>데일리</h2>
      <div className="v3-nav-list">
        {dates.map((item) => (
          <button
            type="button"
            key={item.date}
            className={selectedProjectId === null && selectedDate === item.date ? "is-active" : ""}
            onClick={() => onSelectDate(item.date)}
          >
            <span className="v3-emoji" aria-hidden="true">{item.date === dates[0]?.date ? "📅" : ""}</span>
            <span>{item.label}</span>
          </button>
        ))}
      </div>

      <h2>★ 작업</h2>
      <div className="v3-nav-list" data-testid="v3-starred-projects">
        {starredProjects.map((project) => renderProject(project, "starred"))}
        {starredProjects.length === 0 ? <p>별표 프로젝트가 없습니다.</p> : null}
      </div>

      <h2>전체 프로젝트</h2>
      <div className="v3-nav-list" data-testid="v3-all-projects">
        {allProjects.map((project) => renderProject(project, "all"))}
        {allProjects.length === 0 ? <p>{projectIndexLoading ? "프로젝트를 불러오는 중…" : "프로젝트가 없습니다."}</p> : null}
        {projectIndexHasMore ? (
          <button
            type="button"
            className="v3-new-project-trigger"
            data-testid="v3-load-more-projects"
            disabled={projectIndexLoading}
            onClick={onLoadMoreProjects}
          >
            {projectIndexLoading ? "불러오는 중…" : "프로젝트 더 보기"}
          </button>
        ) : null}
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
            <button
              type="button"
              className="v3-button v3-button--primary"
              disabled={creatingProject || !newProjectTitle.trim()}
              onClick={() => { void createProject(); }}
            >
              {creatingProject ? "…" : "만들기"}
            </button>
          </div>
        ) : null}
        {error ? <p className="v3-project-star-error" role="alert">{error}</p> : null}
      </div>

      <V3ContextMenu
        target={contextMenu?.target ?? null}
        onClose={() => setContextMenu(null)}
        actions={contextMenu ? [
          { label: "프로젝트 열기", onSelect: () => onSelectProject(contextMenu.project.id) },
          { label: "페이지 ID 복사", onSelect: () => navigator.clipboard.writeText(contextMenu.project.id) },
          { label: "이름 변경", onSelect: () => startRename(contextMenu.project, contextMenu.listKind), separatorBefore: true },
          {
            label: isProjectStarred(contextMenu.project, starChanges) ? "별표 해제" : "별표 추가",
            onSelect: () => toggleProjectStar(contextMenu.project),
          },
          { label: "새 업무", onSelect: () => onCreateTask(contextMenu.project.id), separatorBefore: true },
        ] : []}
      />
      <div className="v3-nav-foot">
        업무는 프로젝트에 누적되고,<br />세션은 업무를 수행하는 run.
        <div><kbd>C</kbd> 새 업무 · <kbd>Esc</kbd> 닫기</div>
      </div>
    </nav>
  );
}

function isProjectStarred(project: PageDto, changes: readonly { page: PageDto; starred: boolean }[]): boolean {
  return projectStarredState(project.id, changes, project.metadata.starred === true);
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
