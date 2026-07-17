import { useMemo } from "react";
import type { CatalogFolder } from "@seosoyoung/soul-ui";

import { flattenProjectFolders } from "./project-folders";

export function MobileProjectList({
  folders,
  onSelect,
}: {
  folders: readonly CatalogFolder[];
  onSelect(folder: CatalogFolder): void;
}) {
  const projects = useMemo(() => flattenProjectFolders(folders), [folders]);

  return (
    <section className="v3-mobile-projects border border-glass-border glass-strong glass-chrome lg-rim" aria-label="프로젝트 목록">
      <header>
        <span className="v3-emoji" aria-hidden="true">📁</span>
        <div><small>프로젝트</small><h1>전체 프로젝트</h1></div>
      </header>
      <div className="v3-mobile-project-list" data-testid="v3-mobile-project-list">
        {projects.map(({ folder, depth }) => (
          <button
            key={folder.id}
            type="button"
            style={{ "--v3-mobile-project-depth": depth } as React.CSSProperties}
            onClick={() => onSelect(folder)}
          >
            <span aria-hidden="true">{depth === 0 ? "📂" : "↳"}</span>
            <strong>{folder.name}</strong>
          </button>
        ))}
        {projects.length === 0 ? <p>프로젝트가 없습니다.</p> : null}
      </div>
    </section>
  );
}
