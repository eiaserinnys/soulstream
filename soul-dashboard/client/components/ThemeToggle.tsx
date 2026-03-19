/**
 * ThemeToggle - 다크/라이트 모드 전환 버튼
 *
 * useTheme 훅을 통해 테마 상태를 공유합니다.
 * 같은 훅을 사용하는 다른 컴포넌트(NodeGraph 등)도 즉시 반응합니다.
 */

import { useCallback } from "react";
import { useTheme, cn } from "@seosoyoung/soul-ui";

/** 컴팩트 테마 토글 — 헤더 우상단 배치용 */
export function ThemeToggle() {
  const [theme, setTheme] = useTheme();

  const toggle = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [theme, setTheme]);

  const isDark = theme === "dark";

  return (
    <button
      onClick={toggle}
      className={cn(
        "flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium",
        "border border-border text-muted-foreground hover:bg-input",
        "transition-colors cursor-pointer",
      )}
      title={isDark ? "라이트 모드로 전환" : "다크 모드로 전환"}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
    >
      <span className="text-[12px]">{isDark ? "☀️" : "🌙"}</span>
      <span>{isDark ? "Light" : "Dark"}</span>
    </button>
  );
}
