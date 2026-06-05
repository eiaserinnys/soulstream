export const DASHBOARD_LEFT_SIDEBAR_COLLAPSED_STORAGE_KEY = "soul-ui.dashboard.leftSidebarCollapsed";

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
