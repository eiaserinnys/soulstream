import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import {
  ThemeToggle,
  DashboardIconCap,
  useAtomPublicUrl,
  useGlassSurface,
  useLiquidLens,
} from "@seosoyoung/soul-ui";
import { Gauge, House, Search } from "lucide-react";

import { ConfigButton } from "../components/ConfigButton";
import { AtomDashboardButton } from "./AtomDashboardButton";
import { PersistentSessionEntry } from './PersistentSessionEntry';

export function V3GlobalToolbar({
  onOpenConfig,
  onOpenSearch,
  variant = 'default', agentName, agentOnly = false, showHome = true, onOpenHome, headerRef, showWeeklyUsage, onToggleUsage, sessionSwitch, sessionAction,
  appearance = 'default', atomUrl,
}: {
  onOpenConfig(): void;
  onOpenSearch?(): void;
  variant?: 'default' | 'minimal';
  sessionName?: string;
  agentName?: string | null;
  agentOnly?: boolean;
  showHome?: boolean;
  onOpenHome?(): void;
  sessionSwitch?: ReactNode;
  sessionAction?: ReactNode;
  headerRef?: RefObject<HTMLElement | null>;
  appearance?: "default" | "bare";
  showWeeklyUsage?: boolean;
  onToggleUsage?(): void;
  /** 검수 창이 두 상태를 한 화면에 나란히 보일 때만 넣는다. 없으면 서버가 알려 준 atom 주소를 쓴다. */
  atomUrl?: string | null;
}) {
  const publicAtomUrl = useAtomPublicUrl();
  const atomHref = atomUrl === undefined ? publicAtomUrl : atomUrl;
  const brandCapsuleRef = useRef<HTMLDivElement>(null);
  const searchCapsuleRef = useRef<HTMLButtonElement>(null);
  const brandWebglActive = useGlassSurface(brandCapsuleRef, { enabled: true });
  const searchWebglActive = useGlassSurface(searchCapsuleRef, { enabled: true });
  useLiquidLens(brandCapsuleRef, { scale: 18, enabled: !brandWebglActive });
  useLiquidLens(searchCapsuleRef, { scale: 18, enabled: !searchWebglActive });

  useEffect(() => {
    const openSearch = (event: KeyboardEvent) => {
      if (variant !== 'default' || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      if (variant === 'default') onOpenSearch?.();
    };
    window.addEventListener("keydown", openSearch);
    return () => window.removeEventListener("keydown", openSearch);
  }, [onOpenSearch, variant]);

  if (variant === 'minimal') return <header ref={headerRef} className="persistent-session-header" data-testid="v3-global-toolbar">
    <div className="persistent-session-brand" data-agent-only={agentOnly}>
      <span>소울스트림</span><strong>{agentName}</strong>
    </div>
    <div className="dashboard-toolbar-actions">
      {sessionSwitch}
      {showHome ? <DashboardIconCap label="홈" appearance={appearance} onClick={onOpenHome}>
        {appearance === "bare"
          ? <House className="size-5" strokeWidth={1.4} absoluteStrokeWidth aria-hidden="true" />
          : <span aria-hidden="true" className="text-base leading-none">⌂</span>}
      </DashboardIconCap> : null}
      {sessionAction}
      <ThemeToggle variant="chrome" appearance={appearance}/>
      {onToggleUsage && showWeeklyUsage !== undefined ? <DashboardIconCap appearance={appearance} label="주간 사용량"
        aria-pressed={showWeeklyUsage} className={`persistent-session-weekly-usage-toggle${showWeeklyUsage ? " persistent-session-weekly-usage-toggle--selected" : ""}`}
        onClick={onToggleUsage}>
        <Gauge className="size-5" strokeWidth={1.4} absoluteStrokeWidth aria-hidden="true" />
      </DashboardIconCap> : null}
      <AtomDashboardButton url={atomHref} appearance={appearance}/>
      <ConfigButton variant="chrome" appearance={appearance} onClick={onOpenConfig}/>
    </div>
  </header>;

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
        aria-label="세션 검색 열기"
      >
        <Search className="h-4 w-4 shrink-0" />
        <span className="truncate">세션 검색</span>
        <kbd>⌘K</kbd>
      </button>
      <div className="dashboard-toolbar-actions">
        <PersistentSessionEntry/>
        <AtomDashboardButton url={atomHref} appearance={appearance}/>
        <ConfigButton variant="chrome" appearance={appearance} onClick={onOpenConfig} />
        <ThemeToggle variant="chrome" appearance={appearance} />
      </div>
    </header>
  );
}
