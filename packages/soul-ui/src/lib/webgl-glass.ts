export const WEBGL_GLASS_STORAGE_KEY = "ls.webglGlass";
export const WEBGL_GLASS_CHANGE_EVENT = "ls.webglGlass:change";
export const MAX_WEBGL_GLASS_CARDS = 48;
export const WEBGL_GLASS_OVERSCAN_PX = 40;

const ENABLED_VALUES = new Set(["1", "true", "on", "enabled", "yes"]);

export interface GlassSurfaceRef {
  current: Element | null;
}

export interface GlassSurfaceRegistration {
  id: number;
  ref: GlassSurfaceRef;
}

export interface GlassViewport {
  width: number;
  height: number;
  overscan?: number;
}

export interface PackedGlassSurfaces {
  count: number;
  visibleCount: number;
  overflowCount: number;
  rects: Float32Array;
}

export interface WebglGlassStats {
  fps: number;
  registeredCount: number;
  visibleCount: number;
  drawnCount: number;
  overflowCount: number;
  cappedAt: number;
}

export function isWebglGlassStorageValueEnabled(value: string | null): boolean {
  return value != null && ENABLED_VALUES.has(value.trim().toLowerCase());
}

export function readWebglGlassEnabled(storage: Storage | undefined = getLocalStorage()): boolean {
  if (!storage) return false;
  try {
    return isWebglGlassStorageValueEnabled(storage.getItem(WEBGL_GLASS_STORAGE_KEY));
  } catch {
    return false;
  }
}

export function writeWebglGlassEnabled(
  enabled: boolean,
  storage: Storage | undefined = getLocalStorage(),
): void {
  if (!storage) return;
  try {
    if (enabled) {
      storage.setItem(WEBGL_GLASS_STORAGE_KEY, "1");
    } else {
      storage.removeItem(WEBGL_GLASS_STORAGE_KEY);
    }
  } catch {
    return;
  }
  dispatchWebglGlassChange();
}

export function dispatchWebglGlassChange(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(WEBGL_GLASS_CHANGE_EVENT));
}

export function calculateBackingDpr(devicePixelRatio: number): number {
  if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) return 1.5;
  return Math.min(2, Math.max(1.5, devicePixelRatio));
}

export function createGlassSurfaceBuffer(maxCards = MAX_WEBGL_GLASS_CARDS): Float32Array {
  return new Float32Array(maxCards * 4);
}

export function packVisibleGlassSurfaces(
  registrations: Iterable<GlassSurfaceRegistration>,
  viewport: GlassViewport,
  rects: Float32Array = createGlassSurfaceBuffer(),
  maxCards = MAX_WEBGL_GLASS_CARDS,
): PackedGlassSurfaces {
  const overscan = viewport.overscan ?? WEBGL_GLASS_OVERSCAN_PX;
  let count = 0;
  let visibleCount = 0;
  let overflowCount = 0;

  for (const registration of registrations) {
    const element = registration.ref.current;
    if (!element) continue;
    const rect = element.getBoundingClientRect();
    if (!isVisibleRect(rect, viewport.width, viewport.height, overscan)) continue;
    visibleCount += 1;
    if (count >= maxCards) {
      overflowCount += 1;
      continue;
    }
    const offset = count * 4;
    rects[offset] = rect.left;
    rects[offset + 1] = rect.top;
    rects[offset + 2] = rect.width;
    rects[offset + 3] = rect.height;
    count += 1;
  }

  if (count < maxCards) {
    rects.fill(0, count * 4, maxCards * 4);
  }

  return { count, visibleCount, overflowCount, rects };
}

function isVisibleRect(
  rect: DOMRect | { left: number; right: number; top: number; bottom: number; width: number; height: number },
  viewportWidth: number,
  viewportHeight: number,
  overscan: number,
): boolean {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.right >= -overscan &&
    rect.left <= viewportWidth + overscan &&
    rect.bottom >= -overscan &&
    rect.top <= viewportHeight + overscan
  );
}

function getLocalStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
