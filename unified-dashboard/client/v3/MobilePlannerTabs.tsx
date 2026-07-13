import { useEffect, useState } from "react";

import type { MobilePlannerTab } from "./mobile-planner-state";

const MOBILE_PLANNER_QUERY = "(max-width: 760px)";
const TABS: ReadonlyArray<{ id: MobilePlannerTab; label: string }> = [
  { id: "today", label: "📅 오늘" },
  { id: "task", label: "📋 업무" },
  { id: "chat", label: "💬 채팅" },
];

export function MobilePlannerTabs({
  activeTab,
  onSelect,
}: {
  activeTab: MobilePlannerTab;
  onSelect(tab: MobilePlannerTab): void;
}) {
  return (
    <nav className="v3-mobile-tabs" aria-label="모바일 화면 탭" role="tablist">
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
          {tab.label}
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
