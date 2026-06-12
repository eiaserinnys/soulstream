/**
 * ThemeToggle - 다크/라이트 모드 전환 버튼
 *
 * useTheme 훅을 통해 테마 상태를 공유합니다.
 * 같은 훅을 사용하는 다른 컴포넌트도 즉시 반응합니다.
 */

import { useCallback, useRef } from "react";
import { useTheme } from "../hooks/useTheme";
import { cn } from "../lib/cn";
import { useLiquidLens } from "../lib/liquid-lens";

/** 컴팩트 테마 토글 — 헤더 우상단 배치용 */
export function ThemeToggle({ variant = "default" }: { variant?: "default" | "chrome" }) {
  const [theme, setTheme] = useTheme();

  const toggle = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [theme, setTheme]);

  const isDark = theme === "dark";

  if (variant === "chrome") {
    return <ChromeThemeToggle isDark={isDark} onToggle={toggle} />;
  }

  return (
    <button
      onClick={toggle}
      className={cn(
        "flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-medium",
        "border border-border text-muted-foreground hover:bg-input",
        "transition-colors cursor-pointer",
      )}
      title={isDark ? "라이트 모드로 전환" : "다크 모드로 전환"}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
    >
      <span className="text-xs">{isDark ? "☀️" : "🌙"}</span>
      <span>{isDark ? "Light" : "Dark"}</span>
    </button>
  );
}

function ChromeThemeToggle({ isDark, onToggle }: { isDark: boolean; onToggle: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useLiquidLens(ref, { scale: 22 });

  return (
    <button
      ref={ref}
      type="button"
      onClick={onToggle}
      className="dashboard-icon-cap border border-glass-border glass-strong glass-chrome lg-rim"
      title={isDark ? "라이트 모드로 전환" : "다크 모드로 전환"}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
    >
      <span aria-hidden="true" className="text-base leading-none">◐</span>
    </button>
  );
}
