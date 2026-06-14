/**
 * useTheme - 다크/라이트 테마 상태 관리 훅
 *
 * <html> 요소의 .dark 클래스를 정본으로 사용하며,
 * useSyncExternalStore로 React 컴포넌트에 반응성을 제공합니다.
 *
 * 이 훅을 통해 테마에 의존하는 모든 컴포넌트가 동기화됩니다.
 */

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "soul-dashboard-theme";
export type Theme = "dark" | "light";
export type Appearance = "system" | Theme;

/** 변경 리스너 세트 — setTheme() 호출 시 모든 구독자에게 통지 */
const listeners = new Set<() => void>();
let currentAppearance: Appearance = "system";
let mediaListenerInstalled = false;

/** 현재 DOM 상태에서 테마를 읽는다 */
function getSnapshot(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function getAppearanceSnapshot(): Appearance {
  return currentAppearance;
}

/** SSR fallback (soul-dashboard는 CSR이므로 사실상 사용되지 않음) */
function getServerSnapshot(): Theme {
  return "dark";
}

function getAppearanceServerSnapshot(): Appearance {
  return "system";
}

function resolveAppearance(appearance: Appearance): Theme {
  if (appearance === "light" || appearance === "dark") return appearance;
  if (typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: light)").matches) {
    return "light";
  }
  return "dark";
}

function applyTheme(theme: Theme) {
  if (theme === "dark") {
    document.documentElement.classList.add("dark");
  } else {
    document.documentElement.classList.remove("dark");
  }
}

function getLocalStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function readStoredAppearance(): Appearance | null {
  const storage = getLocalStorage();
  if (!storage) return null;
  try {
    const stored = storage.getItem(STORAGE_KEY);
    return stored === "system" || stored === "light" || stored === "dark" ? stored : null;
  } catch {
    return null;
  }
}

function writeStoredAppearance(appearance: Appearance) {
  const storage = getLocalStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, appearance);
  } catch {
    // Locked-down storage should not break dashboard rendering.
  }
}

function ensureMediaListener() {
  if (mediaListenerInstalled || typeof window === "undefined") return;
  mediaListenerInstalled = true;
  const query = window.matchMedia("(prefers-color-scheme: light)");
  const handleChange = () => {
    if (currentAppearance !== "system") return;
    applyTheme(resolveAppearance("system"));
    listeners.forEach((l) => l());
  };
  query.addEventListener?.("change", handleChange);
}

/** appearance를 적용하고 localStorage에 저장한 뒤, 구독자에게 통지 */
export function setAppearancePreference(
  appearance: Appearance,
  options: { persist?: boolean } = {},
) {
  currentAppearance = appearance;
  applyTheme(resolveAppearance(appearance));
  if (options.persist !== false) {
    writeStoredAppearance(appearance);
  }
  listeners.forEach((l) => l());
}

/** 기존 호출부 호환 API: 토글은 명시 light/dark preference로 저장한다. */
export function setTheme(theme: Theme) {
  setAppearancePreference(theme);
}

/** 마운트 시 localStorage/OS 설정에서 테마 복원 */
export function initTheme() {
  ensureMediaListener();
  setAppearancePreference(readStoredAppearance() ?? "system");
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

/** 서버 동기화용: system/light/dark 원 preference를 구독한다. */
export function useAppearancePreference(): [Appearance, typeof setAppearancePreference] {
  const appearance = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    getAppearanceSnapshot,
    getAppearanceServerSnapshot,
  );
  return [appearance, setAppearancePreference];
}
