/**
 * ConfigButton - 서버 설정 모달 열기 버튼
 *
 * ThemeToggle과 동일한 스타일 패턴.
 * 헤더 우상단 배치용.
 */

import { Button } from "./ui/button";

export function ConfigButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="outline"
      size="xs"
      data-testid="config-button"
      onClick={onClick}
      className="h-auto gap-1.5 px-2 py-0.5 text-xs"
      title="서버 설정"
      aria-label="Open server configuration"
    >
      <span className="text-xs">⚙️</span>
      <span>Config</span>
    </Button>
  );
}
