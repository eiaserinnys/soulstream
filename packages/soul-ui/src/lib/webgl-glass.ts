export const WEBGL_GLASS_STORAGE_KEY = "ls.webglGlass";
export const WEBGL_GLASS_CHANGE_EVENT = "ls.webglGlass:change";
export const MAX_WEBGL_GLASS_CARDS = 64;
export const WEBGL_GLASS_OVERSCAN_PX = 40;

const ENABLED_VALUES = new Set(["1", "true", "on", "enabled", "yes"]);
const DISABLED_VALUES = new Set(["0", "false", "off", "disabled", "no"]);

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
  clips: Float32Array;
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

export function isWebglGlassStorageValueDisabled(value: string | null): boolean {
  return value != null && DISABLED_VALUES.has(value.trim().toLowerCase());
}

export function readWebglGlassOverride(
  storage: Storage | undefined = getLocalStorage(),
): boolean | null {
  if (!storage) return null;
  try {
    const value = storage.getItem(WEBGL_GLASS_STORAGE_KEY);
    if (isWebglGlassStorageValueEnabled(value)) return true;
    if (isWebglGlassStorageValueDisabled(value)) return false;
    return null;
  } catch {
    return null;
  }
}

export function readWebglGlassEnabled(storage: Storage | undefined = getLocalStorage()): boolean {
  return readWebglGlassOverride(storage) ?? true;
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
      storage.setItem(WEBGL_GLASS_STORAGE_KEY, "0");
    }
  } catch {
    return;
  }
  dispatchWebglGlassChange();
}

export function clearWebglGlassOverride(
  storage: Storage | undefined = getLocalStorage(),
): void {
  if (!storage) return;
  try {
    storage.removeItem(WEBGL_GLASS_STORAGE_KEY);
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

export type GlassSurfaceClipAncestorCache = WeakMap<Element, Element | null>;

export interface GlassSurfacePackingOptions {
  rects?: Float32Array;
  clips?: Float32Array;
  maxCards?: number;
  clipAncestorCache?: GlassSurfaceClipAncestorCache;
}

export function packVisibleGlassSurfaces(
  registrations: Iterable<GlassSurfaceRegistration>,
  viewport: GlassViewport,
  optionsOrRects: GlassSurfacePackingOptions | Float32Array = {},
  maxCardsOverride?: number,
): PackedGlassSurfaces {
  const options = optionsOrRects instanceof Float32Array ? { rects: optionsOrRects } : optionsOrRects;
  const maxCards = maxCardsOverride ?? options.maxCards ?? MAX_WEBGL_GLASS_CARDS;
  const rects = options.rects ?? createGlassSurfaceBuffer(maxCards);
  const clips = options.clips ?? createGlassSurfaceBuffer(maxCards);
  const overscan = viewport.overscan ?? WEBGL_GLASS_OVERSCAN_PX;
  const viewportClip = {
    left: -overscan,
    top: -overscan,
    right: viewport.width + overscan,
    bottom: viewport.height + overscan,
    width: viewport.width + overscan * 2,
    height: viewport.height + overscan * 2,
  };
  let count = 0;
  let visibleCount = 0;
  let overflowCount = 0;

  for (const registration of registrations) {
    const element = registration.ref.current;
    if (!element) continue;
    const rect = element.getBoundingClientRect();
    const clipRect = getSurfaceClipRect(element, viewportClip, options.clipAncestorCache);
    if (!clipRect) continue;
    const visibleRect = intersectRects(rect, clipRect);
    if (!visibleRect) continue;
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
    clips[offset] = clipRect.left;
    clips[offset + 1] = clipRect.top;
    clips[offset + 2] = clipRect.width;
    clips[offset + 3] = clipRect.height;
    count += 1;
  }

  if (count < maxCards) {
    rects.fill(0, count * 4, maxCards * 4);
    clips.fill(0, count * 4, maxCards * 4);
  }

  return { count, visibleCount, overflowCount, rects, clips };
}

function getSurfaceClipRect(
  element: Element,
  viewportClip: RectLike,
  clipAncestorCache?: GlassSurfaceClipAncestorCache,
): RectLike | null {
  const clipAncestor = getNearestClipAncestor(element, clipAncestorCache);
  if (!clipAncestor) return viewportClip;
  return intersectRects(viewportClip, clipAncestor.getBoundingClientRect());
}

function getNearestClipAncestor(
  element: Element,
  clipAncestorCache?: GlassSurfaceClipAncestorCache,
): Element | null {
  if (clipAncestorCache?.has(element)) {
    return clipAncestorCache.get(element) ?? null;
  }

  let ancestor = element.parentElement;
  while (ancestor) {
    if (isOverflowClipElement(ancestor)) {
      clipAncestorCache?.set(element, ancestor);
      return ancestor;
    }
    ancestor = ancestor.parentElement;
  }

  clipAncestorCache?.set(element, null);
  return null;
}

function isOverflowClipElement(element: Element): boolean {
  const style = getComputedStyleForElement(element);
  if (!style) return false;
  return (
    isClipOverflowValue(style.overflow) ||
    isClipOverflowValue(style.overflowX) ||
    isClipOverflowValue(style.overflowY)
  );
}

function isClipOverflowValue(value: string): boolean {
  return value === "auto" || value === "scroll" || value === "hidden" || value === "clip" || value === "overlay";
}

function getComputedStyleForElement(element: Element): CSSStyleDeclaration | null {
  const view = element.ownerDocument?.defaultView ?? (typeof window === "undefined" ? undefined : window);
  if (!view) return null;
  try {
    return view.getComputedStyle(element);
  } catch {
    return null;
  }
}

interface RectLike {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

function intersectRects(a: RectLike, b: RectLike): RectLike | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return null;
  return { left, top, right, bottom, width, height };
}

function getLocalStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
