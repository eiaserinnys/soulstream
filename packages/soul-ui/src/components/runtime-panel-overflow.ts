const RUNTIME_PANEL_SCROLL_BASE =
  "mt-2 max-h-[240px] overflow-y-auto overscroll-contain pr-1";

export function runtimePanelScrollClass(extra?: string): string {
  return extra ? `${RUNTIME_PANEL_SCROLL_BASE} ${extra}` : RUNTIME_PANEL_SCROLL_BASE;
}
