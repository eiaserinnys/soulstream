// 시안 화면의 바탕. 운영의 ComponentsReviewLayout과 같은 겉틀을 서버 없이 세운다.
// 손으로 다시 그린 시안이 빠뜨리던 것(토큰 범위 .v3-shell, 유리 뒤의 배경, 테마 클래스)을
// 여기서 한 번만 맞추고, 시안은 실제 컴포넌트를 올리기만 한다.
import { initialAppearance } from "./mock-env";
import "./mockup.css";

import { StrictMode, useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  LiquidGlassCanvas, LiquidGlassProvider, ToastProvider, WallpaperLayer,
  setAppearancePreference, useGlassSurface,
} from "@seosoyoung/soul-ui";
import { AuthProvider } from "@seosoyoung/soul-ui/providers";
import { V3_CARD_GAP_PX, V3_OUTER_INSET_PX } from "../../client/v3/v3-layout-metrics";
import "../../client/v3/v3-dashboard-styles";
import "../../client/v3/v3-folder-section-navigation.css";
import "../../client/v3/components-review.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

function Surface({ children }: { children: ReactNode }) {
  const surfaceRef = useRef<HTMLElement>(null);
  const webglActive = useGlassSurface(surfaceRef, { enabled: true });

  useEffect(() => {
    setAppearancePreference(initialAppearance, { persist: false });
    // 바깥 틀(index.html)의 테마 전환을 받는다. 화면 상태는 유지된다.
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const theme = (event.data as { type?: string; theme?: string } | null);
      if (theme?.type === "mockup:theme" && (theme.theme === "light" || theme.theme === "dark")) {
        setAppearancePreference(theme.theme, { persist: false });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return <div className="v3-shell v3-components-page isolate font-sans"
    style={{ "--v3-card-gap": `${V3_CARD_GAP_PX}px`, "--v3-outer-inset": `${V3_OUTER_INSET_PX}px` } as CSSProperties}>
    <WallpaperLayer />
    <LiquidGlassCanvas />
    <main ref={surfaceRef} className="v3-components-main glass-strong glass-chrome"
      data-liquid-glass-webgl={webglActive ? "true" : undefined}>
      {children}
    </main>
  </div>;
}

export function MockupShell({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <ToastProvider>
        <LiquidGlassProvider renderDefaultCanvas={false}><Surface>{children}</Surface></LiquidGlassProvider>
      </ToastProvider>
    </AuthProvider>
  </QueryClientProvider>;
}

export function mountMockup(children: ReactNode) {
  const root = document.getElementById("root");
  if (!root) throw new Error("#root 가 없습니다.");
  createRoot(root).render(<StrictMode><MockupShell>{children}</MockupShell></StrictMode>);
}
