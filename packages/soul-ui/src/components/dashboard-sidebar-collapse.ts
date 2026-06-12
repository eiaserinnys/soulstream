export const DASHBOARD_LEFT_SIDEBAR_COLLAPSED_STORAGE_KEY = "soul-ui.dashboard.leftSidebarCollapsed";
export const DASHBOARD_LEFT_SIDEBAR_WIDTH_STORAGE_KEY = "soul-ui.dashboard.leftSidebarWidth";
export const DASHBOARD_LEFT_SIDEBAR_DEFAULT_WIDTH = 264;
export const DASHBOARD_LEFT_SIDEBAR_MIN_WIDTH = 220;
export const DASHBOARD_LEFT_SIDEBAR_MAX_WIDTH = 420;

function getDashboardStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function readDashboardLeftSidebarCollapsed(storage?: Storage): boolean {
  try {
    const targetStorage = storage ?? getDashboardStorage();
    return targetStorage?.getItem(DASHBOARD_LEFT_SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeDashboardLeftSidebarCollapsed(
  collapsed: boolean,
  storage?: Storage,
): void {
  try {
    const targetStorage = storage ?? getDashboardStorage();
    targetStorage?.setItem(DASHBOARD_LEFT_SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed ? "true" : "false");
  } catch {
    // Private browsing and locked-down embeds can reject localStorage writes.
  }
}

export function clampDashboardLeftSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return DASHBOARD_LEFT_SIDEBAR_DEFAULT_WIDTH;
  return Math.max(
    DASHBOARD_LEFT_SIDEBAR_MIN_WIDTH,
    Math.min(DASHBOARD_LEFT_SIDEBAR_MAX_WIDTH, width),
  );
}

export function readDashboardLeftSidebarWidth(storage?: Storage): number {
  try {
    const targetStorage = storage ?? getDashboardStorage();
    const stored = targetStorage?.getItem(DASHBOARD_LEFT_SIDEBAR_WIDTH_STORAGE_KEY);
    if (stored == null) return DASHBOARD_LEFT_SIDEBAR_DEFAULT_WIDTH;
    return clampDashboardLeftSidebarWidth(Number.parseFloat(stored));
  } catch {
    return DASHBOARD_LEFT_SIDEBAR_DEFAULT_WIDTH;
  }
}

export function writeDashboardLeftSidebarWidth(
  width: number,
  storage?: Storage,
): void {
  try {
    const targetStorage = storage ?? getDashboardStorage();
    targetStorage?.setItem(
      DASHBOARD_LEFT_SIDEBAR_WIDTH_STORAGE_KEY,
      String(clampDashboardLeftSidebarWidth(width)),
    );
  } catch {
    // Private browsing and locked-down embeds can reject localStorage writes.
  }
}

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

export function isDashboardSidebarToggleShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): boolean {
  if (event.key.toLowerCase() !== "b" || event.shiftKey || event.altKey) return false;
  const isMac = /Mac|iPhone|iPad|iPod/i.test(platform);
  return isMac ? event.metaKey : event.ctrlKey;
}
