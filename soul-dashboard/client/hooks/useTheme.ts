/**
 * useTheme - 다크/라이트 테마 상태 관리 훅
 *
 * <html> 요소의 .dark 클래스를 정본으로 사용하며,
 * useSyncExternalStore로 React 컴포넌트에 반응성을 제공합니다.
 *
 * 이 훅을 통해 ThemeToggle과 NodeGraph(colorMode) 등
 * 테마에 의존하는 모든 컴포넌트가 동기화됩니다.
 */

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "soul-dashboard-theme";
export type Theme = "dark" | "light";

/** 변경 리스너 세트 — setTheme() 호출 시 모든 구독자에게 통지 */
const listeners = new Set<() => void>();

/** 현재 DOM 상태에서 테마를 읽는다 */
function getSnapshot(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** SSR fallback (soul-dashboard는 CSR이므로 사실상 사용되지 않음) */
function getServerSnapshot(): Theme {
  return "dark";
}

/** 테마를 적용하고 localStorage에 저장한 뒤, 구독자에게 통지 */
export function setTheme(theme: Theme) {
  if (theme === "dark") {
    document.documentElement.classList.add("dark");
  } else {
    document.documentElement.classList.remove("dark");
  }
  localStorage.setItem(STORAGE_KEY, theme);
  listeners.forEach((l) => l());
}

/** 마운트 시 localStorage/OS 설정에서 테마 복원 */
export function initTheme() {
  const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
  if (stored === "light" || stored === "dark") {
    setTheme(stored);
    return;
  }
  // localStorage에 없으면 OS 설정 확인
  if (window.matchMedia("(prefers-color-scheme: light)").matches) {
    setTheme("light");
    return;
  }
  // 기본: index.html의 class="dark" 유지
}

/** 테마 상태를 구독하는 React 훅 */
export function useTheme(): [Theme, typeof setTheme] {
  const theme = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    getSnapshot,
    getServerSnapshot,
  );
  return [theme, setTheme];
}
