import {
  DASHBOARD_LEFT_SIDEBAR_WIDTH_STORAGE_KEY,
} from "@seosoyoung/soul-ui/components/dashboard-sidebar-collapse";

export const V3_CARD_GAP_PX = 4;
export const V3_PANEL_GAP_PX = 16;
export const V3_OUTER_INSET_PX = 20;
export const V3_NAVIGATION_DEFAULT_WIDTH_PX = 336;
export const V3_CONTENT_MAX_WIDTH_PX = 960;
export const V3_SESSION_PANEL_DEFAULT_WIDTH_PX = 500;

export function readV3NavigationWidth(storage?: Storage): number | null {
  try {
    const target = storage ?? globalThis.localStorage;
    const raw = target.getItem(DASHBOARD_LEFT_SIDEBAR_WIDTH_STORAGE_KEY);
    if (raw === null || raw.trim() === "") return null;
    const width = Number(raw);
    return Number.isFinite(width) ? width : null;
  } catch {
    return null;
  }
}

export function writeV3NavigationWidth(width: number, storage?: Storage): void {
  try {
    const target = storage ?? globalThis.localStorage;
    target.setItem(DASHBOARD_LEFT_SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(width)));
  } catch {
    // Storage can be unavailable in sandboxed/private contexts.
  }
}
