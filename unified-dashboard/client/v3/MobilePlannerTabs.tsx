import { useEffect, useRef, useState } from "react";
import { useGlassSurface } from "@seosoyoung/soul-ui";

import type { MobilePlannerTab } from "./mobile-planner-state";

const MOBILE_PLANNER_QUERY = "(max-width: 760px)";
const TABS: ReadonlyArray<{ id: MobilePlannerTab; icon: string; label: string }> = [
  { id: "today", icon: "📅", label: "오늘" },
  { id: "projects", icon: "📁", label: "프로젝트" },
  { id: "task", icon: "📋", label: "업무" },
  { id: "chat", icon: "💬", label: "채팅" },
];

export function MobilePlannerTabs({
  activeTab,
  onSelect,
}: {
  activeTab: MobilePlannerTab;
  onSelect(tab: MobilePlannerTab): void;
}) {
  const surfaceRef = useRef<HTMLElement>(null);
  const webglActive = useGlassSurface(surfaceRef, { enabled: true });

  return (
    <nav
      ref={surfaceRef}
      className="v3-mobile-tabs border border-glass-border glass-strong glass-chrome"
      data-liquid-glass-webgl={webglActive ? "true" : undefined}
      aria-label="모바일 화면 탭"
      role="tablist"
    >
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={`v3-mobile-tab${activeTab === tab.id ? " is-active" : ""}`}
          role="tab"
          aria-selected={activeTab === tab.id}
          data-testid={`v3-mobile-tab-${tab.id}`}
          onClick={() => onSelect(tab.id)}
        >
          <span className="v3-emoji" aria-hidden="true">{tab.icon}</span> {tab.label}
        </button>
      ))}
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
