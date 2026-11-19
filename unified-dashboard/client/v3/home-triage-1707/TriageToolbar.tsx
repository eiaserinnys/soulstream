// 시안 C 의 떠 있는 유리 도구 막대. 운영 정본 V3GlobalToolbar 에 브랜드 홈 복귀와
// PAS 진입만 시안용으로 얹는다. 상시 세션 진입은 서버를 부르므로 숨긴다.
import { useRef } from "react";
import { ProfileAvatar, useGlassSurface } from "@seosoyoung/soul-ui";

import { V3GlobalToolbar } from "../V3GlobalToolbar";

export function TriageToolbar({ view, onOpenHome, onOpenPas }: { view: "home" | "pas"; onOpenHome(): void; onOpenPas(): void }) {
  const pasRef = useRef<HTMLButtonElement>(null);
  const pasGlass = useGlassSurface(pasRef, { enabled: true });

  return (
    <V3GlobalToolbar
      onOpenConfig={() => {}}
      onOpenSearch={() => {}}
      onOpenHome={onOpenHome}
      showPersistentEntry={false}
      extraActions={(
        <button
          ref={pasRef}
          type="button"
          className="dashboard-toolbar-cap v3-ht-pas-entry border border-glass-border glass-strong glass-chrome lg-rim"
          aria-pressed={view === "pas"}
          data-liquid-glass-webgl={pasGlass ? "true" : undefined}
          onClick={onOpenPas}
          data-testid="pas-entry"
        >
          <ProfileAvatar
            role="assistant"
            shape="circle"
            hasPortrait
            portraitUrl="/api/nodes/eias-linegames/agents/seosoyoung/portrait"
            fallbackEmoji="🤖"
          />
          <span className="v3-ht-pas-entry-label">PAS 서소영</span>
        </button>
      )}
    />
  );
}
