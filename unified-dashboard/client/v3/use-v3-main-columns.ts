import { useCallback, useEffect, useMemo, useState } from "react";

import { readV3NavigationWidth, writeV3NavigationWidth } from "./v3-layout-metrics";
import {
  resolveV3MainColumns,
  dragV3Navigation,
  dragV3SessionPanel,
  type V3MainColumnPreferences,
} from "./v3-main-columns";
import { readV3SessionPanelWidth, writeV3SessionPanelWidth } from "./v3-session-panel-width";

function readViewportWidth(): number {
  return document.documentElement.clientWidth;
}

export function useV3MainColumns() {
  const [viewportWidth, setViewportWidth] = useState(readViewportWidth);
  const [preferences, setPreferences] = useState<V3MainColumnPreferences>(() => ({
    navigationWidth: readV3NavigationWidth(),
    sessionPanelWidth: readV3SessionPanelWidth(),
  }));
  const visibleWidths = useMemo(
    () => resolveV3MainColumns(viewportWidth, preferences),
    [preferences, viewportWidth],
  );

  useEffect(() => {
    const updateViewportWidth = () => setViewportWidth(readViewportWidth());
    window.addEventListener("resize", updateViewportWidth);
    return () => window.removeEventListener("resize", updateViewportWidth);
  }, []);

  const resizeNavigation = useCallback((deltaPercent: number) => {
    setPreferences((current) => {
      const currentViewportWidth = readViewportWidth();
      const currentWidths = resolveV3MainColumns(currentViewportWidth, current);
      const deltaPx = currentViewportWidth * deltaPercent / 100;
      const nextWidths = dragV3Navigation(currentWidths, currentViewportWidth, deltaPx);
      const nextPreferences = {
        navigationWidth: Math.round(nextWidths.navigationWidth),
        sessionPanelWidth: Math.round(nextWidths.sessionPanelWidth),
      };
      writeV3NavigationWidth(nextPreferences.navigationWidth);
      writeV3SessionPanelWidth(nextPreferences.sessionPanelWidth);
      return nextPreferences;
    });
  }, []);

  const resizeSessionPanel = useCallback((deltaPercent: number) => {
    setPreferences((current) => {
      const currentViewportWidth = readViewportWidth();
      const currentWidths = resolveV3MainColumns(currentViewportWidth, current);
      const deltaPx = currentViewportWidth * deltaPercent / 100;
      const nextWidths = dragV3SessionPanel(currentWidths, currentViewportWidth, deltaPx);
      const nextPreferences = {
        navigationWidth: Math.round(nextWidths.navigationWidth),
        sessionPanelWidth: Math.round(nextWidths.sessionPanelWidth),
      };
      writeV3NavigationWidth(nextPreferences.navigationWidth);
      writeV3SessionPanelWidth(nextPreferences.sessionPanelWidth);
      return nextPreferences;
    });
  }, []);

  return {
    navigationWidth: visibleWidths.navigationWidth,
    sessionPanelWidth: visibleWidths.sessionPanelWidth,
    resizeNavigation,
    resizeSessionPanel,
  };
}
