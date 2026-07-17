/**
 * ConfigButton - 서버 설정 모달 열기 버튼 (unified-dashboard)
 *
 * soul-dashboard의 ConfigButton에서 포팅.
 * ThemeToggle과 동일한 스타일 패턴. 헤더 우상단 배치용.
 */

import { cn, DashboardIconCap } from "@seosoyoung/soul-ui";

export function ConfigButton({
  onClick,
  variant = "default",
}: {
  onClick: () => void;
  variant?: "default" | "chrome";
}) {
  if (variant === "chrome") {
    return <ChromeConfigButton onClick={onClick} />;
  }

  return (
    <button
      data-testid="config-button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-medium",
        "border border-border text-muted-foreground hover:bg-input",
        "transition-colors cursor-pointer",
      )}
      title="서버 설정"
      aria-label="Open server configuration"
    >
      <span className="text-xs">⚙️</span>
      <span>Config</span>
    </button>
  );
}

function ChromeConfigButton({ onClick }: { onClick: () => void }) {
  return (
    <DashboardIconCap
      label="서버 설정"
      data-testid="config-button"
      onClick={onClick}
    >
      <span aria-hidden="true" className="text-base leading-none">⚙</span>
    </DashboardIconCap>
  );
}
