import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import { useGlassSurface } from "@seosoyoung/soul-ui";

import type { MobilePlannerTab } from "./mobile-planner-state";

const MOBILE_PLANNER_QUERY = "(max-width: 760px)";
const TABS: ReadonlyArray<{ id: MobilePlannerTab; icon: string; label: string }> = [
  { id: "today", icon: "▦", label: "folders.sections.cards" },
  { id: "projects", icon: "📁", label: "folders.mobile.allFolders" },
  { id: "task", icon: "📋", label: "folders.common.folder" },
  { id: "chat", icon: "💬", label: "folders.mobile.chat" },
];
const folderTabLabels: Readonly<Record<string, { projects: string; task: string }>> = {
  ja: { projects: "フォルダ", task: "詳細" },
  "zh-Hans": { projects: "文件夹", task: "详情" },
};

export function MobilePlannerTabs({
  activeTab,
  onSelect,
}: {
  activeTab: MobilePlannerTab;
  onSelect(tab: MobilePlannerTab): void;
}) {
  const { t, i18n } = useTranslation();
  const shortLabels = folderTabLabels[i18n.resolvedLanguage ?? ""];
  const surfaceRef = useRef<HTMLElement>(null);
  const webglActive = useGlassSurface(surfaceRef, { enabled: true });

  return (
    <nav
      ref={surfaceRef}
      className="v3-mobile-tabs border border-glass-border glass-strong glass-chrome"
      data-liquid-glass-webgl={webglActive ? "true" : undefined}
      aria-label={t("folders.mobile.tabs")}
      role="tablist"
    >
      {TABS.map((tab) => {
        const label = t(tab.label);
        const shortLabel = tab.id === "projects" || tab.id === "task" ? shortLabels?.[tab.id] : undefined;
        return (
        <button
          key={tab.id}
          type="button"
          className={`v3-mobile-tab${activeTab === tab.id ? " is-active" : ""}`}
          role="tab"
          aria-label={shortLabel ? label : undefined}
          aria-selected={activeTab === tab.id}
          data-testid={`v3-mobile-tab-${tab.id}`}
          onClick={() => onSelect(tab.id)}
        >
          <span className="v3-emoji" aria-hidden="true">{tab.icon}</span> {shortLabel ?? label}
        </button>
        );
      })}
    </nav>
  );
}

export function useMobilePlannerMode(): boolean {
  const [matches, setMatches] = useState(() => (
    typeof window !== "undefined" && window.matchMedia(MOBILE_PLANNER_QUERY).matches
  ));

  useEffect(() => {
    const query = window.matchMedia(MOBILE_PLANNER_QUERY);
    const update = () => setMatches(query.matches);
    query.addEventListener("change", update);
    update();
    return () => query.removeEventListener("change", update);
  }, []);

  return matches;
}
