import {
  clampDashboardLeftSidebarWidth,
  DASHBOARD_LEFT_SIDEBAR_WIDTH_STORAGE_KEY,
} from "@seosoyoung/soul-ui/components/dashboard-sidebar-collapse";

export const V3_CARD_GAP_PX = 4;
export const V3_PANEL_GAP_PX = 16;
export const V3_OUTER_INSET_PX = 20;
export const V3_NAVIGATION_DEFAULT_WIDTH_PX = 336;
export const V3_CONTENT_MAX_WIDTH_PX = 960;
export const V3_SESSION_PANEL_DEFAULT_WIDTH_PX = 500;

export function readV3NavigationWidth(storage?: Storage): number {
  try {
    const target = storage ?? globalThis.localStorage;
    const raw = target.getItem(DASHBOARD_LEFT_SIDEBAR_WIDTH_STORAGE_KEY);
    if (raw === null) return V3_NAVIGATION_DEFAULT_WIDTH_PX;
    const width = Number.parseFloat(raw);
    return Number.isFinite(width)
      ? clampDashboardLeftSidebarWidth(width)
      : V3_NAVIGATION_DEFAULT_WIDTH_PX;
  } catch {
    return V3_NAVIGATION_DEFAULT_WIDTH_PX;
  }
}
