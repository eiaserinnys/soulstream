/**
 * ConfigButton - 서버 설정 모달 열기 버튼 (unified-dashboard)
 *
 * soul-dashboard의 ConfigButton에서 포팅.
 * ThemeToggle과 동일한 스타일 패턴. 헤더 우상단 배치용.
 */

import { cn } from "@seosoyoung/soul-ui";

export function ConfigButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      data-testid="config-button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium",
        "border border-border text-muted-foreground hover:bg-input",
        "transition-colors cursor-pointer",
      )}
      title="서버 설정"
      aria-label="Open server configuration"
    >
      <span className="text-[12px]">⚙️</span>
      <span>Config</span>
    </button>
  );
}
