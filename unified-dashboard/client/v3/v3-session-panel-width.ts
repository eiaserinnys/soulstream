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


// Card overlays share the dashboard's existing localStorage layout preference path.
export const V3_CARD_WORKSPACE_STORAGE_KEY = "soulstream-v3-card-workspace-layout";
export function readV3CardWorkspaceLayout(): import("./card-workspace-layout").CardWorkspaceLayout|null {
  try {
    const raw=window.localStorage.getItem(V3_CARD_WORKSPACE_STORAGE_KEY);
    if(raw===null)return null;
    const value=JSON.parse(raw);
    return (value.totalWidth===null||Number.isFinite(value.totalWidth)&&value.totalWidth>0)
      &&(value.ratio===null||Number.isFinite(value.ratio)&&value.ratio>0&&value.ratio<1)
      &&(value.totalWidth!==null||value.ratio!==null)
      ?{totalWidth:value.totalWidth,ratio:value.ratio}:null;
  } catch {return null;}
}
export function writeV3CardWorkspaceLayout(value:import("./card-workspace-layout").CardWorkspaceLayout|null):void {
  try {
    if(value===null)window.localStorage.removeItem(V3_CARD_WORKSPACE_STORAGE_KEY);
    else window.localStorage.setItem(V3_CARD_WORKSPACE_STORAGE_KEY,JSON.stringify({totalWidth:value.totalWidth,ratio:value.ratio}));
  } catch {
    // Match the existing panel preference when browser storage is unavailable.
  }
}
