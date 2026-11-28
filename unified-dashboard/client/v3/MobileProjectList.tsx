import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
  const projects = useMemo(() => flattenProjectFolders(folders.filter((folder) => !folder.archived)), [folders]);

  return (
    <section className="v3-mobile-projects border border-glass-border glass-strong glass-chrome lg-rim" aria-label={t("folders.picker.list")}>
      <header>
        <span className="v3-emoji" aria-hidden="true">📁</span>
        <div><small>{t("folders.common.folder")}</small><h1>{t("folders.mobile.allFolders")}</h1></div>
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
        {projects.length === 0 ? <p>{t("folders.mobile.empty")}</p> : null}
      </div>
    </section>
  );
}
