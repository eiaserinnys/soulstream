import type { PageDto } from "@seosoyoung/soul-ui/page";

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
}: {
  dates: readonly PlannerDateNavItem[];
  selectedDate: string;
  projects: readonly PageDto[];
  selectedProjectId: string | null;
  onSelectDate(date: string): void;
  onSelectProject(projectId: string): void;
}) {
  return (
    <nav className="v3-navigation" aria-label="플래너 내비게이션">
      <div className="v3-brand"><span aria-hidden="true">🌊</span><strong>소울스트림</strong></div>
      <h2>데일리</h2>
      <div className="v3-nav-list">
        {dates.map((item) => (
          <button
            type="button"
            key={item.date}
            className={selectedProjectId === null && selectedDate === item.date ? "is-active" : ""}
            onClick={() => onSelectDate(item.date)}
          >
            <span aria-hidden="true">{item.date === dates[0]?.date ? "📅" : ""}</span>
            <span>{item.label}</span>
          </button>
        ))}
      </div>
      <h2>★ 프로젝트</h2>
      <div className="v3-nav-list">
        {projects.map((project) => (
          <button
            type="button"
            key={project.id}
            className={selectedProjectId === project.id ? "is-active" : ""}
            onClick={() => onSelectProject(project.id)}
          >
            <span className="v3-project-bullet" aria-hidden="true">◆</span>
            <span>{project.title}</span>
            <span className="v3-nav-star" aria-hidden="true">★</span>
          </button>
        ))}
        {projects.length === 0 ? <p>별표 프로젝트가 없습니다.</p> : null}
      </div>
      <div className="v3-nav-foot">
        업무는 프로젝트에 누적되고,<br />세션은 업무를 수행하는 run.
        <div><kbd>C</kbd> 새 업무 · <kbd>Esc</kbd> 닫기</div>
      </div>
    </nav>
  );
}
