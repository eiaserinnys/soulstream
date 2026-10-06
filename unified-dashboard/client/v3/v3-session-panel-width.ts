export const V3_SESSION_PANEL_STORAGE_KEY = "soulstream-v3-session-panel-width";

export function readV3SessionPanelWidth(storage?: Storage): number | null {
  try {
    const target = storage ?? globalThis.localStorage;
    const raw = target.getItem(V3_SESSION_PANEL_STORAGE_KEY);
    if (raw === null || raw.trim() === "") return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeV3SessionPanelWidth(width: number, storage?: Storage): void {
  try {
    const target = storage ?? globalThis.localStorage;
    target.setItem(
      V3_SESSION_PANEL_STORAGE_KEY,
      String(Math.round(width)),
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
