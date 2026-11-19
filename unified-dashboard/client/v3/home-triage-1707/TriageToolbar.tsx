// 시안 C 의 떠 있는 유리 도구 막대. 운영 V3GlobalToolbar 의 기본형(브랜드 캡슐, 검색 캡슐, 우측 진입)을
// 같은 클래스로 세우고, 운영에서 서버를 부르는 PAS 진입만 시안용 버튼으로 바꿨다.
import { useRef } from "react";
import { Search } from "lucide-react";
import { ThemeToggle, useGlassSurface } from "@seosoyoung/soul-ui";

export function TriageToolbar({ view, onOpenPas }: { view: "home" | "pas"; onOpenPas(): void }) {
  const brandRef = useRef<HTMLDivElement>(null);
  const pasRef = useRef<HTMLButtonElement>(null);
  const brandGlass = useGlassSurface(brandRef, { enabled: true });
  const pasGlass = useGlassSurface(pasRef, { enabled: true });

  return (
    <header className="dashboard-floating-toolbar v3-global-toolbar" data-testid="v3-global-toolbar">
      <div
        ref={brandRef}
        className="dashboard-toolbar-cap dashboard-toolbar-brand border border-glass-border glass-strong glass-chrome lg-rim"
        data-liquid-glass-webgl={brandGlass ? "true" : undefined}
      >
        <span aria-hidden="true" className="dashboard-brand-orb" />
        <span className="font-semibold text-foreground">Soulstream</span>
      </div>
      <button
        type="button"
        className="dashboard-toolbar-cap dashboard-toolbar-search border border-glass-border glass-strong glass-chrome lg-rim"
        disabled
        title="시안에서는 세션 검색을 열지 않습니다"
      >
        <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="truncate">세션 검색</span>
        <kbd>⌘K</kbd>
      </button>
      <div className="dashboard-toolbar-actions">
        <button
          ref={pasRef}
          type="button"
          className="dashboard-toolbar-cap v3-ht-pas-entry border border-glass-border glass-strong glass-chrome lg-rim"
          aria-pressed={view === "pas"}
          data-liquid-glass-webgl={pasGlass ? "true" : undefined}
          onClick={onOpenPas}
          data-testid="pas-entry"
        >
          <span className="v3-ht-pas-entry-avatar" aria-hidden="true">서</span>
          <span className="v3-ht-pas-entry-label">PAS 서소영</span>
        </button>
        <ThemeToggle variant="chrome" />
      </div>
    </header>
  );
}
