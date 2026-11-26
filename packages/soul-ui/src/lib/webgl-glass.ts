export const WEBGL_GLASS_STORAGE_KEY = "ls.webglGlass";
export const WEBGL_GLASS_CHANGE_EVENT = "ls.webglGlass:change";
export const MAX_WEBGL_GLASS_CARDS = 64;
export const WEBGL_GLASS_OVERSCAN_PX = 40;
/** 표면의 계산 곡률을 읽지 못했을 때만 쓰는 대체 곡률. */
export const DEFAULT_GLASS_SURFACE_RADIUS = 22;

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
  clipRadii: Float32Array;
  /** 표면마다 등록 요소의 계산 곡률. 읽지 못한 표면만 DEFAULT_GLASS_SURFACE_RADIUS. */
  radii: Float32Array;
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

export function createGlassSurfaceScalarBuffer(maxCards = MAX_WEBGL_GLASS_CARDS): Float32Array {
  return new Float32Array(maxCards);
}

export type GlassSurfaceClipAncestorCache = WeakMap<Element, Element[]>;

export interface GlassSurfacePackingOptions {
  rects?: Float32Array;
  clips?: Float32Array;
  clipRadii?: Float32Array;
  radii?: Float32Array;
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
  const clipRadii = options.clipRadii ?? createGlassSurfaceScalarBuffer(maxCards);
  const radii = options.radii ?? createGlassSurfaceScalarBuffer(maxCards);
  const overscan = viewport.overscan ?? WEBGL_GLASS_OVERSCAN_PX;
  const viewportClip = {
    left: -overscan,
    top: -overscan,
    right: viewport.width + overscan,
    bottom: viewport.height + overscan,
    width: viewport.width + overscan * 2,
    height: viewport.height + overscan * 2,
    radius: 0,
  };
  let count = 0;
  let visibleCount = 0;
  let overflowCount = 0;

  for (const registration of registrations) {
    const element = registration.ref.current;
    if (!element) continue;
    // 숨김 처리된 표면(예: 스크림 아래로 내려간 전역 도구 막대)은 캔버스에 남기지 않는다.
    // 계산 스타일은 아래 곡률 읽기와 함께 쓴다.
    const style = getComputedStyleForElement(element);
    if (style?.visibility === "hidden" || style?.visibility === "collapse") continue;
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
    clipRadii[count] = clipRect.radius;
    radii[count] = readMaxBorderRadiusFromStyle(style, rect) ?? DEFAULT_GLASS_SURFACE_RADIUS;
    count += 1;
  }

  if (count < maxCards) {
    rects.fill(0, count * 4, maxCards * 4);
    clips.fill(0, count * 4, maxCards * 4);
    clipRadii.fill(0, count, maxCards);
    radii.fill(0, count, maxCards);
  }

  return { count, visibleCount, overflowCount, rects, clips, clipRadii, radii };
}

function getSurfaceClipRect(
  element: Element,
  viewportClip: ClipRect,
  clipAncestorCache?: GlassSurfaceClipAncestorCache,
): ClipRect | null {
  const clipAncestors = getClipAncestors(element, clipAncestorCache);
  let clipRect: ClipRect = viewportClip;
  for (const ancestor of clipAncestors) {
    const ancestorRect = toRectLike(ancestor.getBoundingClientRect());
    if (!ancestorRect) continue;
    const nextRect = intersectRects(clipRect, ancestorRect);
    if (!nextRect) return null;
    clipRect = {
      ...nextRect,
      radius: Math.max(
        clipRect.radius,
        readMaxBorderRadius(ancestor, ancestorRect) ?? 0,
      ),
    };
  }
  return clipRect;
}

function getClipAncestors(
  element: Element,
  clipAncestorCache?: GlassSurfaceClipAncestorCache,
): Element[] {
  if (clipAncestorCache?.has(element)) {
    return clipAncestorCache.get(element) ?? [];
  }

  const ancestors: Element[] = [];
  let ancestor = element.parentElement;
  while (ancestor) {
    if (isOverflowClipElement(ancestor)) {
      ancestors.push(ancestor);
    }
    ancestor = ancestor.parentElement;
  }

  clipAncestorCache?.set(element, ancestors);
  return ancestors;
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

interface ClipRect extends RectLike {
  radius: number;
}

function toRectLike(
  rect: DOMRect | { left: number; right: number; top: number; bottom: number; width: number; height: number },
): RectLike | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  return rect;
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

function readMaxBorderRadius(element: Element, bounds: RectLike): number | null {
  return readMaxBorderRadiusFromStyle(getComputedStyleForElement(element), bounds);
}

function readMaxBorderRadiusFromStyle(style: CSSStyleDeclaration | null, bounds: RectLike): number | null {
  if (!style) return null;
  return Math.max(
    parseBorderRadius(style.borderTopLeftRadius, bounds),
    parseBorderRadius(style.borderTopRightRadius, bounds),
    parseBorderRadius(style.borderBottomRightRadius, bounds),
    parseBorderRadius(style.borderBottomLeftRadius, bounds),
    parseBorderRadius(style.borderRadius, bounds),
  );
}

function parseBorderRadius(value: string, bounds: RectLike): number {
  const firstRadius = value.trim().split(/\s+/)[0] ?? "";
  if (!firstRadius) return 0;
  const numeric = Number.parseFloat(firstRadius);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  if (firstRadius.endsWith("%")) {
    return Math.min(bounds.width, bounds.height) * numeric / 100;
  }
  return numeric;
}

function getLocalStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
