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
