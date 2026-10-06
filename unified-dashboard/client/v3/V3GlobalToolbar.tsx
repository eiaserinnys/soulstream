import { useEffect, useRef, type RefObject } from "react";
import {
  ThemeToggle,
  DashboardIconCap,
  useGlassSurface,
  useLiquidLens,
} from "@seosoyoung/soul-ui";
import { Home, Search } from "lucide-react";

import { ConfigButton } from "../components/ConfigButton";
import { PersistentSessionEntry } from './PersistentSessionEntry';

export function V3GlobalToolbar({
  onOpenConfig,
  onOpenSearch,
  variant = 'default', sessionName, onOpenHome, headerRef,
}: {
  onOpenConfig(): void;
  onOpenSearch?(): void;
  variant?: 'default' | 'minimal';
  sessionName?: string;
  onOpenHome?(): void;
  headerRef?: RefObject<HTMLElement | null>;
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
      if (variant === 'default') onOpenSearch?.();
    };
    window.addEventListener("keydown", openSearch);
    return () => window.removeEventListener("keydown", openSearch);
  }, [onOpenSearch, variant]);

  if (variant === 'minimal') return <header ref={headerRef} className="persistent-session-header" data-testid="v3-global-toolbar">
    <div className="persistent-session-brand"><span>소울스트림</span><strong>{sessionName}</strong></div>
    <div className="dashboard-toolbar-actions">
      <DashboardIconCap label="홈" onClick={onOpenHome}><Home/></DashboardIconCap>
      <ThemeToggle variant="chrome"/>
      <ConfigButton variant="chrome" onClick={onOpenConfig}/>
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
        aria-label="Open session search"
      >
        <Search className="h-4 w-4 shrink-0" />
        <span className="truncate">Search sessions</span>
        <kbd>⌘K</kbd>
      </button>
      <div className="dashboard-toolbar-actions">
        <PersistentSessionEntry/>
        <ConfigButton variant="chrome" onClick={onOpenConfig} />
        <ThemeToggle variant="chrome" />
      </div>
    </header>
  );
}
