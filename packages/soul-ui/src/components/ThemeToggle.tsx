/**
 * ThemeToggle - 다크/라이트 모드 전환 버튼
 *
 * useTheme 훅을 통해 테마 상태를 공유합니다.
 * 같은 훅을 사용하는 다른 컴포넌트도 즉시 반응합니다.
 */

import { useCallback } from "react";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "../hooks/useTheme";
import { cn } from "../lib/cn";
import { DashboardIconCap } from "./DashboardIconCap";

/** 컴팩트 테마 토글 — 헤더 우상단 배치용 */
export function ThemeToggle({
  variant = "default",
  appearance = "default",
}: { variant?: "default" | "chrome"; appearance?: "default" | "bare" }) {
  const [theme, setTheme] = useTheme();

  const toggle = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [theme, setTheme]);

  const isDark = theme === "dark";

  if (variant === "chrome") {
    return <ChromeThemeToggle isDark={isDark} onToggle={toggle} appearance={appearance} />;
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

function ChromeThemeToggle({
  isDark,
  onToggle,
  appearance,
}: { isDark: boolean; onToggle: () => void; appearance: "default" | "bare" }) {
  return (
    <DashboardIconCap
      label={isDark ? "라이트 모드로 전환" : "다크 모드로 전환"}
      appearance={appearance}
      onClick={onToggle}
    >
      {appearance === "bare" ? (
        isDark
          ? <Sun className="size-5" strokeWidth={1.4} absoluteStrokeWidth aria-hidden="true" />
          : <Moon className="size-5" strokeWidth={1.4} absoluteStrokeWidth aria-hidden="true" />
      ) : <span aria-hidden="true" className="text-base leading-none">◐</span>}
    </DashboardIconCap>
  );
}
