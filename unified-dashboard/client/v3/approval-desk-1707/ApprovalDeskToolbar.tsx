import { ClipboardCheck, House, MessageSquare } from "lucide-react";
import { V3GlobalToolbar } from "../V3GlobalToolbar";

export type DashboardScreen = "desk" | "home" | "pas" | "board";

/** 시안 A의 화면 전환 막대. 운영 도구 막대를 그대로 쓰고 가운데 칸만 화면 전환으로 바꾼다. */
export function ApprovalDeskToolbar({ screen, deskCount, onNavigate }: {
  screen: DashboardScreen;
  deskCount: number;
  onNavigate(screen: DashboardScreen): void;
}) {
  const home = screen === "home" || screen === "board";
  return <div className="ad1707-toolbar-wrap">
    <V3GlobalToolbar
      onOpenConfig={() => {}}
      onOpenSearch={() => {}}
      centerSlot={<nav className="ad1707-toolbar-nav border border-glass-border glass-strong glass-chrome lg-rim" aria-label="화면 전환">
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
      </nav>}
    />
  </div>;
}
