import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { initTheme, LiquidGlassCanvas, LiquidGlassProvider, useGlassSurface, WallpaperLayer, useInitialCatalogLoad, useAuth, useUserPreferencesSync } from "@seosoyoung/soul-ui";
import { ComponentsReviewPage } from "./ComponentsReviewPage";
import { V3_CARD_GAP_PX, V3_OUTER_INSET_PX } from "./v3-layout-metrics";
import "./v3-dashboard-styles";
import "./v3-folder-section-navigation.css";
import "./components-review.css";

// AuthGate in main.tsx owns authentication for this route and the dashboard.
export function ComponentsReviewLayout({ children }: { children?: ReactNode } = {}) {
  return <LiquidGlassProvider renderDefaultCanvas={false}><ComponentsReviewContent>{children}</ComponentsReviewContent></LiquidGlassProvider>;
}

function ComponentsReviewContent({ children }: { children?: ReactNode }) {
  const { user } = useAuth();
  useInitialCatalogLoad(true);
  useUserPreferencesSync(user?.email);
  const surfaceRef = useRef<HTMLElement>(null);
  const webglActive = useGlassSurface(surfaceRef, { enabled: true });
  useEffect(() => { initTheme(); }, []);

  return <div className="v3-shell v3-components-page isolate font-sans"
    style={{ "--v3-card-gap": `${V3_CARD_GAP_PX}px`, "--v3-outer-inset":`${V3_OUTER_INSET_PX}px` } as CSSProperties}>
    <WallpaperLayer />
    <LiquidGlassCanvas />
    <main ref={surfaceRef} className="v3-components-main glass-strong glass-chrome"
      data-liquid-glass-webgl={webglActive ? "true" : undefined}>
      {children === undefined ? <ComponentsReviewPage /> : children}
    </main>
  </div>;
}
