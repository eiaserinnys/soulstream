import {
  V3_NAVIGATION_DEFAULT_WIDTH_PX,
  V3_PANEL_GAP_PX,
  V3_SESSION_PANEL_DEFAULT_WIDTH_PX,
} from "./v3-layout-metrics";

export const V3_MAIN_NAVIGATION_MIN_WIDTH_PX = 220;
export const V3_MAIN_SESSION_PANEL_MIN_WIDTH_PX = 240;
export const V3_MAIN_CONTENT_MIN_WIDTH_PX = 320;
// This is the 22px outer margin in .v3-shell's grid in v3-planner.css.
export const V3_MAIN_COLUMNS_OUTER_MARGIN_PX = 22;

export type V3MainColumnPreferences = {
  navigationWidth: number | null;
  sessionPanelWidth: number | null;
};

export type V3MainColumnWidths = {
  navigationWidth: number;
  sessionPanelWidth: number;
};

function getAdjacentColumnBudget(viewportWidth: number): number {
  return viewportWidth
    - 2 * V3_MAIN_COLUMNS_OUTER_MARGIN_PX
    - 2 * V3_PANEL_GAP_PX
    - V3_MAIN_CONTENT_MIN_WIDTH_PX;
}

function clamp(width: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, width));
}

export function resolveV3MainColumns(
  viewportWidth: number,
  preferences: V3MainColumnPreferences,
): V3MainColumnWidths {
  const adjacentColumnBudget = getAdjacentColumnBudget(viewportWidth);
  const navigationPreference = preferences.navigationWidth ?? V3_NAVIGATION_DEFAULT_WIDTH_PX;
  const sessionPanelPreference = preferences.sessionPanelWidth ?? V3_SESSION_PANEL_DEFAULT_WIDTH_PX;
  const navigationWidth = Math.round(clamp(
    navigationPreference,
    V3_MAIN_NAVIGATION_MIN_WIDTH_PX,
    Math.max(V3_MAIN_NAVIGATION_MIN_WIDTH_PX, adjacentColumnBudget - V3_MAIN_SESSION_PANEL_MIN_WIDTH_PX),
  ));
  const sessionPanelWidth = Math.round(clamp(
    sessionPanelPreference,
    V3_MAIN_SESSION_PANEL_MIN_WIDTH_PX,
    Math.max(V3_MAIN_SESSION_PANEL_MIN_WIDTH_PX, adjacentColumnBudget - navigationWidth),
  ));

  return { navigationWidth, sessionPanelWidth };
}

export function dragV3Navigation(
  currentWidths: V3MainColumnWidths,
  viewportWidth: number,
  deltaPx: number,
): V3MainColumnWidths {
  const adjacentColumnBudget = getAdjacentColumnBudget(viewportWidth);
  return {
    navigationWidth: clamp(
      currentWidths.navigationWidth + deltaPx,
      V3_MAIN_NAVIGATION_MIN_WIDTH_PX,
      Math.max(
        V3_MAIN_NAVIGATION_MIN_WIDTH_PX,
        adjacentColumnBudget - currentWidths.sessionPanelWidth,
      ),
    ),
    sessionPanelWidth: currentWidths.sessionPanelWidth,
  };
}

export function dragV3SessionPanel(
  currentWidths: V3MainColumnWidths,
  viewportWidth: number,
  deltaPx: number,
): V3MainColumnWidths {
  const adjacentColumnBudget = getAdjacentColumnBudget(viewportWidth);
  return {
    navigationWidth: currentWidths.navigationWidth,
    sessionPanelWidth: clamp(
      currentWidths.sessionPanelWidth - deltaPx,
      V3_MAIN_SESSION_PANEL_MIN_WIDTH_PX,
      Math.max(
        V3_MAIN_SESSION_PANEL_MIN_WIDTH_PX,
        adjacentColumnBudget - currentWidths.navigationWidth,
      ),
    ),
  };
}
