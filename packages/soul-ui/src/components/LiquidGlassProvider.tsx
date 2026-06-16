import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import { useTheme } from "../hooks/useTheme";
import { isChromiumLensRuntime } from "../lib/liquid-lens";
import {
  createGlassSurfaceBuffer,
  packVisibleGlassSurfaces,
  readWebglGlassOverride,
  WEBGL_GLASS_CHANGE_EVENT,
  type GlassSurfaceRef,
  type GlassSurfaceRegistration,
  type WebglGlassStats,
} from "../lib/webgl-glass";
import { normalizeLiquidGlassSettings } from "../lib/glass-settings";
import { createWebglGlassRenderer, type WebglGlassRenderer } from "../lib/webgl-glass-renderer";
import {
  loadWallpaperPhotoImage,
  resolveWallpaperPhotoUrl,
} from "../lib/webgl-glass-wallpaper";
import { useDashboardStore } from "../stores/dashboard-store";

const REDUCED_TRANSPARENCY_QUERY = "(prefers-reduced-transparency: reduce)";
const TOGGLE_POLL_MS = 700;
const GLASS_TINT_CSS_VAR = "--liquid-glass-tint-strength";

interface LiquidGlassRegistryContextValue {
  enabled: boolean;
  register: (ref: GlassSurfaceRef) => () => void;
}

const LiquidGlassRegistryContext = createContext<LiquidGlassRegistryContextValue | null>(null);

export function LiquidGlassProvider({ children }: { children: ReactNode }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<WebglGlassRenderer | null>(null);
  const registrationsRef = useRef(new Map<number, GlassSurfaceRegistration>());
  const nextIdRef = useRef(0);
  const rectBufferRef = useRef(createGlassSurfaceBuffer());
  const statsRef = useRef<WebglGlassStats>({
    fps: 0,
    registeredCount: 0,
    visibleCount: 0,
    drawnCount: 0,
    overflowCount: 0,
    cappedAt: rectBufferRef.current.length / 4,
  });
  const [devOverride, setDevOverride] = useState<boolean | null>(() => readWebglGlassOverride());
  const [runtimeAvailable, setRuntimeAvailable] = useState(false);
  const [rendererReady, setRendererReady] = useState(false);
  const [theme] = useTheme();
  const wallpaper = useDashboardStore((state) => state.wallpaper);
  const liquidGlass = useDashboardStore((state) => state.liquidGlass);
  const glassSettings = useMemo(() => normalizeLiquidGlassSettings(liquidGlass), [liquidGlass]);
  const glassSettingsRef = useRef(glassSettings);
  const preferenceEnabled = devOverride ?? glassSettings.enabled;
  const shouldMountCanvas = preferenceEnabled && runtimeAvailable;
  const enabled = shouldMountCanvas && rendererReady;

  useEffect(() => {
    const syncPreference = () => setDevOverride(readWebglGlassOverride());
    const interval = window.setInterval(syncPreference, TOGGLE_POLL_MS);
    window.addEventListener("storage", syncPreference);
    window.addEventListener(WEBGL_GLASS_CHANGE_EVENT, syncPreference);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("storage", syncPreference);
      window.removeEventListener(WEBGL_GLASS_CHANGE_EVENT, syncPreference);
    };
  }, []);

  useEffect(() => {
    const media = getReducedTransparencyMatcher();
    const syncRuntime = () => {
      setRuntimeAvailable(
        isChromiumLensRuntime() &&
        !isReducedTransparencyPreferred(media) &&
        hasWebgl2Context(),
      );
    };
    syncRuntime();
    media?.addEventListener?.("change", syncRuntime);
    return () => media?.removeEventListener?.("change", syncRuntime);
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    document.documentElement.style.setProperty(GLASS_TINT_CSS_VAR, String(glassSettings.tint));
    return () => {
      document.documentElement.style.removeProperty(GLASS_TINT_CSS_VAR);
    };
  }, [glassSettings.tint]);

  const register = useCallback((ref: GlassSurfaceRef) => {
    const id = ++nextIdRef.current;
    registrationsRef.current.set(id, { id, ref });
    return () => {
      registrationsRef.current.delete(id);
    };
  }, []);

  const contextValue = useMemo<LiquidGlassRegistryContextValue>(
    () => ({ enabled, register }),
    [enabled, register],
  );

  useEffect(() => {
    if (!shouldMountCanvas || !canvasRef.current) {
      rendererRef.current?.destroy();
      rendererRef.current = null;
      setRendererReady(false);
      publishStats(statsRef.current);
      return undefined;
    }

    const renderer = createWebglGlassRenderer(canvasRef.current);
    if (!renderer) {
      rendererRef.current = null;
      setRendererReady(false);
      return undefined;
    }
    rendererRef.current = renderer;
    renderer.updateSettings(glassSettingsRef.current);
    setRendererReady(true);

    let animationFrame = 0;
    let frames = 0;
    let lastFpsAt = performance.now();
    const renderFrame = (time: number) => {
      const currentRenderer = rendererRef.current;
      if (!currentRenderer) return;
      currentRenderer.resize();
      const packed = packVisibleGlassSurfaces(
        registrationsRef.current.values(),
        { width: window.innerWidth, height: window.innerHeight },
        rectBufferRef.current,
      );
      currentRenderer.render(packed);

      frames += 1;
      if (time - lastFpsAt >= 500) {
        statsRef.current = {
          fps: Math.round(frames * 1000 / Math.max(1, time - lastFpsAt)),
          registeredCount: registrationsRef.current.size,
          visibleCount: packed.visibleCount,
          drawnCount: packed.count,
          overflowCount: packed.overflowCount,
          cappedAt: rectBufferRef.current.length / 4,
        };
        publishStats(statsRef.current);
        frames = 0;
        lastFpsAt = time;
      }
      animationFrame = window.requestAnimationFrame(renderFrame);
    };
    animationFrame = window.requestAnimationFrame(renderFrame);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      renderer.destroy();
      if (rendererRef.current === renderer) rendererRef.current = null;
      setRendererReady(false);
    };
  }, [shouldMountCanvas]);

  useEffect(() => {
    glassSettingsRef.current = glassSettings;
    rendererRef.current?.updateSettings(glassSettings);
  }, [glassSettings]);

  useEffect(() => {
    if (!rendererReady || !rendererRef.current) return undefined;
    let cancelled = false;

    const updateTexture = async () => {
      const renderer = rendererRef.current;
      if (!renderer) return;
      const photoImage = wallpaper.mode === "photo"
        ? await loadWallpaperPhotoImage(resolveWallpaperPhotoUrl(wallpaper))
        : null;
      if (cancelled || rendererRef.current !== renderer) return;
      renderer.updateWallpaper({ settings: wallpaper, theme, photoImage });
    };

    void updateTexture();
    return () => {
      cancelled = true;
    };
  }, [rendererReady, theme, wallpaper]);

  return (
    <LiquidGlassRegistryContext.Provider value={contextValue}>
      {shouldMountCanvas ? (
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          className="liquid-glass-webgl-canvas"
          data-liquid-glass-webgl-provider="true"
        />
      ) : null}
      {children}
    </LiquidGlassRegistryContext.Provider>
  );
}

export function useGlassSurface(
  ref: RefObject<HTMLElement | null>,
  options: { enabled?: boolean } = {},
): boolean {
  const context = useContext(LiquidGlassRegistryContext);
  const shouldRegister = Boolean(options.enabled && context?.enabled);

  useEffect(() => {
    if (!shouldRegister || !context) return undefined;
    return context.register(ref);
  }, [context, ref, shouldRegister]);

  return shouldRegister;
}

function getReducedTransparencyMatcher(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  try {
    return window.matchMedia(REDUCED_TRANSPARENCY_QUERY);
  } catch {
    return null;
  }
}

function isReducedTransparencyPreferred(media: MediaQueryList | null): boolean {
  return media?.matches ?? false;
}

function hasWebgl2Context(): boolean {
  if (typeof document === "undefined") return false;
  const canvas = document.createElement("canvas");
  try {
    return Boolean(canvas.getContext("webgl2"));
  } catch {
    return false;
  }
}

function publishStats(stats: WebglGlassStats): void {
  if (typeof window === "undefined") return;
  (window as typeof window & { __soulstreamWebglGlassStats?: WebglGlassStats }).__soulstreamWebglGlassStats = stats;
}
