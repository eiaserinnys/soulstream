import { V3_SESSION_PANEL_DEFAULT_WIDTH_PX } from "./v3-layout-metrics";

export const V3_SESSION_PANEL_STORAGE_KEY = "soulstream-v3-session-panel-width";
export const V3_SESSION_PANEL_DEFAULT_WIDTH = V3_SESSION_PANEL_DEFAULT_WIDTH_PX;
export const V3_SESSION_PANEL_MAX_WIDTH = 560;

const V3_SESSION_PANEL_MIN_WIDTH = 240;

export function clampV3SessionPanelWidth(width: number): number {
  return Math.min(
    V3_SESSION_PANEL_MAX_WIDTH,
    Math.max(V3_SESSION_PANEL_MIN_WIDTH, Math.round(width)),
  );
}

export function readV3SessionPanelWidth(): number {
  try {
    const raw = window.localStorage.getItem(V3_SESSION_PANEL_STORAGE_KEY);
    if (raw === null) return V3_SESSION_PANEL_DEFAULT_WIDTH;
    const parsed = Number(raw);
    return Number.isFinite(parsed)
      ? clampV3SessionPanelWidth(parsed)
      : V3_SESSION_PANEL_DEFAULT_WIDTH;
  } catch {
    return V3_SESSION_PANEL_DEFAULT_WIDTH;
  }
}

export function writeV3SessionPanelWidth(width: number): void {
  try {
    window.localStorage.setItem(
      V3_SESSION_PANEL_STORAGE_KEY,
      String(clampV3SessionPanelWidth(width)),
    );
  } catch {
    // Storage can be unavailable in sandboxed/private contexts.
  }
}
