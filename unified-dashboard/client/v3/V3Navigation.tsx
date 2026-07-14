import { useMemo, useRef, useState } from "react";
import { useGlassSurface } from "@seosoyoung/soul-ui";
import { createPageApiClient, type PageDto } from "@seosoyoung/soul-ui/page";

import { createStarredProject, renameProjectPage, setProjectStarred } from "./project-star-actions";
import {
  applyProjectStarChanges,
  publishProjectStarChange,
  useProjectStarChanges,
} from "./project-star-store";
import { V3ContextMenu, type V3ContextMenuTarget } from "./V3ContextMenu";
import "./v3-project-star.css";

export interface PlannerDateNavItem {
  date: string;
  label: string;
}

export function V3Navigation({
  dates,
  selectedDate,
  projects,
  selectedProjectId,
  onSelectDate,
  onSelectProject,
  onCreateTask,
}: {
  dates: readonly PlannerDateNavItem[];
  selectedDate: string;
  projects: readonly PageDto[];
  selectedProjectId: string | null;
  onSelectDate(date: string): void;
  onSelectProject(projectId: string): void;
  onCreateTask(projectId: string): void;
}) {
  const surfaceRef = useRef<HTMLElement>(null);
  const webglActive = useGlassSurface(surfaceRef, { enabled: true });
  const api = useMemo(() => createPageApiClient(), []);
  const starChanges = useProjectStarChanges();
  const visibleProjects = applyProjectStarChanges(projects, starChanges);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectTitle, setNewProjectTitle] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [pendingStarId, setPendingStarId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ target: V3ContextMenuTarget; project: PageDto } | null>(null);
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

  const removeProjectStar = async (project: PageDto) => {
    if (pendingStarId) return;
    if (!window.confirm(`“${project.title}” 프로젝트의 별표를 해제할까요?\n내비게이션에서 제거됩니다.`)) return;
    setPendingStarId(project.id);
    setError(null);
    try {
      const updated = await setProjectStarred(api, project.id, false);
      publishProjectStarChange({ page: updated, starred: false });
    } catch (cause) {
      setError(`별표 해제 실패 · ${errorText(cause)}`);
    } finally {
      setPendingStarId(null);
    }
  };

  const renameProject = async (project: PageDto) => {
    const title = window.prompt("프로젝트 이름", project.title)?.trim();
    if (!title || title === project.title) return;
    setError(null);
    try {
      const updated = await renameProjectPage(api, project.id, title);
      publishProjectStarChange({ page: updated, starred: true });
    } catch (cause) {
      setError(`프로젝트 이름 변경 실패 · ${errorText(cause)}`);
    }
  };

  return (
    <nav
      ref={surfaceRef}
      className="v3-navigation border border-glass-border glass-strong glass-chrome lg-rim"
      data-liquid-glass-webgl={webglActive ? "true" : undefined}
      aria-label="플래너 내비게이션"
    >
      <div className="v3-brand"><span className="v3-emoji" aria-hidden="true">🌊</span><strong>소울스트림</strong></div>
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
      <h2>★ 프로젝트</h2>
      <div className="v3-nav-list">
        {visibleProjects.map((project) => (
          <div
            key={project.id}
            className={`v3-project-nav-row${selectedProjectId === project.id ? " is-active" : ""}`}
            onContextMenu={(event) => {
              event.preventDefault();
              setContextMenu({ target: { x: event.clientX, y: event.clientY }, project });
            }}
          >
            <button
              type="button"
              className={`v3-project-nav-link${selectedProjectId === project.id ? " is-active" : ""}`}
              onClick={() => onSelectProject(project.id)}
            >
              <span className="v3-project-bullet" aria-hidden="true">◆</span>
              <span>{project.title}</span>
            </button>
            <button
              type="button"
              className="v3-project-star-toggle"
              aria-label={`${project.title} 별표 해제`}
              title="별표 해제"
              disabled={pendingStarId === project.id}
              onClick={() => { void removeProjectStar(project); }}
            >
              ★
            </button>
          </div>
        ))}
        {visibleProjects.length === 0 ? <p>별표 프로젝트가 없습니다.</p> : null}
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
          { label: "이름 변경", onSelect: () => renameProject(contextMenu.project), separatorBefore: true },
          { label: "별표 해제", onSelect: () => removeProjectStar(contextMenu.project) },
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

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
