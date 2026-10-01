import { useEffect, useRef, type CSSProperties } from "react";
import { initTheme, LiquidGlassCanvas, LiquidGlassProvider, useGlassSurface, WallpaperLayer } from "@seosoyoung/soul-ui";
import { ComponentsReviewPage } from "./ComponentsReviewPage";
import { V3_CARD_GAP_PX } from "./v3-layout-metrics";
import "./v3-dashboard-styles";
import "./v3-folder-section-navigation.css";
import "./components-review.css";

// AuthGate in main.tsx owns authentication for this route and the dashboard.
export function ComponentsReviewLayout() {
  return <LiquidGlassProvider renderDefaultCanvas={false}><ComponentsReviewContent /></LiquidGlassProvider>;
}

function ComponentsReviewContent() {
  const surfaceRef = useRef<HTMLElement>(null);
  const webglActive = useGlassSurface(surfaceRef, { enabled: true });
  useEffect(() => { initTheme(); }, []);

  return <div className="v3-shell v3-components-page isolate font-sans"
    style={{ "--v3-card-gap": `${V3_CARD_GAP_PX}px` } as CSSProperties}>
    <WallpaperLayer />
    <LiquidGlassCanvas />
    <main ref={surfaceRef} className="v3-components-main glass-strong glass-chrome"
      data-liquid-glass-webgl={webglActive ? "true" : undefined}>
      <ComponentsReviewPage />
    </main>
  </div>;
}
