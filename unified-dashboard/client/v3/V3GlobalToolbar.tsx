import { useEffect, useRef } from "react";
import {
  DashboardIconCap,
  ThemeToggle,
  useGlassSurface,
  useLiquidLens,
} from "@seosoyoung/soul-ui";
import { LayoutDashboard, Plus, Search, Sun } from "lucide-react";

import { ConfigButton } from "../components/ConfigButton";
import { LEGACY_DASHBOARD_PATH } from "../dashboard-routes";

export function V3GlobalToolbar({
  onOpenConfig,
  onOpenNewTask,
  onOpenRitual,
  onOpenSearch,
}: {
  onOpenConfig(): void;
  onOpenNewTask(): void;
  onOpenRitual(): void;
  onOpenSearch(): void;
}) {
  const brandCapsuleRef = useRef<HTMLDivElement>(null);
  const searchCapsuleRef = useRef<HTMLButtonElement>(null);
  const brandWebglActive = useGlassSurface(brandCapsuleRef, { enabled: true });
  const searchWebglActive = useGlassSurface(searchCapsuleRef, { enabled: true });
  useLiquidLens(brandCapsuleRef, { scale: 18, enabled: !brandWebglActive });
  useLiquidLens(searchCapsuleRef, { scale: 18, enabled: !searchWebglActive });

  useEffect(() => {
    const openSearch = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      onOpenSearch();
    };
    window.addEventListener("keydown", openSearch);
    return () => window.removeEventListener("keydown", openSearch);
  }, [onOpenSearch]);

  return (
    <header className="dashboard-floating-toolbar v3-global-toolbar" data-testid="v3-global-toolbar">
      <div
        ref={brandCapsuleRef}
        className="dashboard-toolbar-cap dashboard-toolbar-brand border border-glass-border glass-strong glass-chrome lg-rim"
        data-liquid-glass-webgl={brandWebglActive ? "true" : undefined}
      >
        <span aria-hidden="true" className="dashboard-brand-orb" />
        <span className="font-semibold text-foreground">Soulstream</span>
      </div>
      <button
        ref={searchCapsuleRef}
        type="button"
        className="dashboard-toolbar-cap dashboard-toolbar-search border border-glass-border glass-strong glass-chrome lg-rim"
        data-liquid-glass-webgl={searchWebglActive ? "true" : undefined}
        onClick={onOpenSearch}
        aria-label="Open session search"
      >
        <Search className="h-4 w-4 shrink-0" />
        <span className="truncate">Search sessions</span>
        <kbd>⌘K</kbd>
      </button>
      <div className="dashboard-toolbar-actions">
        <DashboardIconCap
          label="아침 정리"
          onClick={onOpenRitual}
        >
          <Sun className="h-4 w-4" aria-hidden="true" />
        </DashboardIconCap>
        <DashboardIconCap
          label="새 업무"
          onClick={onOpenNewTask}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
        </DashboardIconCap>
        <DashboardIconCap
          label="기존 대시보드 열기"
          onClick={() => window.location.assign(LEGACY_DASHBOARD_PATH)}
        >
          <LayoutDashboard className="h-4 w-4" aria-hidden="true" />
        </DashboardIconCap>
        <ConfigButton variant="chrome" onClick={onOpenConfig} />
        <ThemeToggle variant="chrome" />
      </div>
    </header>
  );
}
