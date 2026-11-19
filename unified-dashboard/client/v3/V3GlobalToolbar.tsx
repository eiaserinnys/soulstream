import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import {
  ThemeToggle,
  DashboardIconCap,
  useGlassSurface,
  useLiquidLens,
} from "@seosoyoung/soul-ui";
import { Gauge, House, Search } from "lucide-react";

import { ConfigButton } from "../components/ConfigButton";
import { PersistentSessionEntry } from './PersistentSessionEntry';

export function V3GlobalToolbar({
  onOpenConfig,
  onOpenSearch,
  variant = 'default', agentName, agentOnly = false, showHome = true, onOpenHome, headerRef, showWeeklyUsage, onToggleUsage, sessionSwitch,
  appearance = 'default', extraActions, showPersistentEntry = true,
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
  headerRef?: RefObject<HTMLElement | null>;
  appearance?: "default" | "bare";
  showWeeklyUsage?: boolean;
  onToggleUsage?(): void;
  /** 우측 기본 진입 앞에 끼울 시안 전용 진입. 운영 호출은 넘기지 않는다. */
  extraActions?: ReactNode;
  /** 서버를 부르는 상시 세션 진입을 숨긴다. 기본값은 운영과 같은 표시. */
  showPersistentEntry?: boolean;
}) {
  const brandCapsuleRef = useRef<HTMLDivElement>(null);
  const brandButtonRef = useRef<HTMLButtonElement>(null);
  const brandRef = onOpenHome ? brandButtonRef : brandCapsuleRef;
  const searchCapsuleRef = useRef<HTMLButtonElement>(null);
  const brandWebglActive = useGlassSurface(brandRef, { enabled: true });
  const searchWebglActive = useGlassSurface(searchCapsuleRef, { enabled: true });
  useLiquidLens(brandRef, { scale: 18, enabled: !brandWebglActive });
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
      <ThemeToggle variant="chrome" appearance={appearance}/>
      {onToggleUsage && showWeeklyUsage !== undefined ? <DashboardIconCap appearance={appearance} label="주간 사용량"
        aria-pressed={showWeeklyUsage} className={`persistent-session-weekly-usage-toggle${showWeeklyUsage ? " persistent-session-weekly-usage-toggle--selected" : ""}`}
        onClick={onToggleUsage}>
        <Gauge className="size-5" strokeWidth={1.4} absoluteStrokeWidth aria-hidden="true" />
      </DashboardIconCap> : null}
      <ConfigButton variant="chrome" appearance={appearance} onClick={onOpenConfig}/>
    </div>
  </header>;

  const brandClassName = "dashboard-toolbar-cap dashboard-toolbar-brand border border-glass-border glass-strong glass-chrome lg-rim";
  return (
    <header className="dashboard-floating-toolbar v3-global-toolbar" data-testid="v3-global-toolbar">
      {onOpenHome ? (
        <button
          ref={brandButtonRef}
          type="button"
          className={brandClassName}
          data-liquid-glass-webgl={brandWebglActive ? "true" : undefined}
          onClick={onOpenHome}
          aria-label="홈 열기"
          title="홈 열기"
          data-testid="brand-home"
        >
          <span aria-hidden="true" className="dashboard-brand-orb" />
          <span className="font-semibold text-foreground">Soulstream</span>
        </button>
      ) : (
        <div
          ref={brandCapsuleRef}
          className={brandClassName}
          data-liquid-glass-webgl={brandWebglActive ? "true" : undefined}
        >
          <span aria-hidden="true" className="dashboard-brand-orb" />
          <span className="font-semibold text-foreground">Soulstream</span>
        </div>
      )}
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
        {showPersistentEntry ? <PersistentSessionEntry/> : null}
        {extraActions}
        <ConfigButton variant="chrome" appearance={appearance} onClick={onOpenConfig} />
        <ThemeToggle variant="chrome" appearance={appearance} />
      </div>
    </header>
  );
}
