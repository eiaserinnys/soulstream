import { useRef } from "react";
import { DashboardIconCap, ThemeToggle, useGlassSurface } from "@seosoyoung/soul-ui";
import { ClipboardCheck, House, MessageSquare } from "lucide-react";

export type DashboardScreen = "desk" | "home" | "pas" | "board";

/** 시안 A의 화면 전환 막대. 운영 V3GlobalToolbar와 같은 겉틀과 유리 재질을 쓴다. */
export function ApprovalDeskToolbar({ screen, deskCount, onNavigate }: {
  screen: DashboardScreen;
  deskCount: number;
  onNavigate(screen: DashboardScreen): void;
}) {
  const brandRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const brandWebgl = useGlassSurface(brandRef, { enabled: true });
  const navWebgl = useGlassSurface(navRef, { enabled: true });
  const home = screen === "home" || screen === "board";
  return <header className="dashboard-floating-toolbar v3-global-toolbar ad1707-toolbar" data-testid="ad1707-toolbar">
    <div ref={brandRef}
      className="dashboard-toolbar-cap dashboard-toolbar-brand border border-glass-border glass-strong glass-chrome lg-rim"
      data-liquid-glass-webgl={brandWebgl ? "true" : undefined}>
      <span aria-hidden="true" className="dashboard-brand-orb" />
      <span className="font-semibold text-foreground">Soulstream</span>
    </div>
    <nav ref={navRef}
      className="ad1707-toolbar-nav border border-glass-border glass-strong glass-chrome lg-rim"
      data-liquid-glass-webgl={navWebgl ? "true" : undefined} aria-label="화면 전환">
      <button type="button" className={`ad1707-nav-button${home ? " is-active" : ""}`}
        aria-current={home ? "page" : undefined} onClick={() => onNavigate("home")}>
        <House className="size-4" strokeWidth={1.6} aria-hidden="true" />
        <span>홈 플래너</span>
      </button>
      <button type="button" className={`ad1707-nav-button${screen === "desk" ? " is-active" : ""}`}
        aria-current={screen === "desk" ? "page" : undefined} onClick={() => onNavigate("desk")}>
        <ClipboardCheck className="size-4" strokeWidth={1.6} aria-hidden="true" />
        <span>결재 데스크</span>
        <span className="ad1707-nav-badge" aria-label={`미결재 ${deskCount}건`}>{deskCount}</span>
      </button>
      <button type="button" className={`ad1707-nav-button${screen === "pas" ? " is-active" : ""}`}
        aria-current={screen === "pas" ? "page" : undefined} onClick={() => onNavigate("pas")}>
        <MessageSquare className="size-4" strokeWidth={1.6} aria-hidden="true" />
        <span>PAS 서소영</span>
      </button>
    </nav>
    <div className="dashboard-toolbar-actions">
      <DashboardIconCap label="결재 데스크 열기" onClick={() => onNavigate("desk")}>
        <ClipboardCheck className="size-5" strokeWidth={1.4} absoluteStrokeWidth aria-hidden="true" />
      </DashboardIconCap>
      <ThemeToggle variant="chrome" />
    </div>
  </header>;
}
