import { useEffect, type RefObject } from "react";

const SVG_NS = "http://www.w3.org/2000/svg";
const MAX_MAP_SIDE = 400;
const DEFAULT_LENS_SCALE = 48;
const EDGE_EXPONENT = 1.7;
const INTERIOR_REFRACTION = 0.3;
const RESIZE_DEBOUNCE_MS = 120;
const REDUCED_TRANSPARENCY_QUERY = "(prefers-reduced-transparency: reduce)";

let lensUid = 0;
let defsElement: SVGDefsElement | null = null;

export interface LiquidLensOptions {
  scale?: number;
  enabled?: boolean;
}

export interface LiquidLensMapSize {
  width: number;
  height: number;
  downsample: number;
}

export interface LiquidLensMapMetrics {
  width: number;
  height: number;
  radius: number;
  band: number;
}

interface LensVector {
  dx: number;
  dy: number;
}

export function calculateLiquidLensMapSize(width: number, height: number): LiquidLensMapSize {
  const downsample = Math.max(1, Math.ceil(Math.max(width, height) / MAX_MAP_SIDE));
  return {
    width: Math.ceil(width / downsample),
    height: Math.ceil(height / downsample),
    downsample,
  };
}

function roundedRectSignedDistance(px: number, py: number, metrics: LiquidLensMapMetrics): number {
  const cx = metrics.width / 2;
  const cy = metrics.height / 2;
  const hx = metrics.width / 2;
  const hy = metrics.height / 2;
  const qx = Math.abs(px - cx) - (hx - metrics.radius);
  const qy = Math.abs(py - cy) - (hy - metrics.radius);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);

  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - metrics.radius;
}

export function sampleLiquidLensVector(
  x: number,
  y: number,
  metrics: LiquidLensMapMetrics,
): LensVector {
  const cx = metrics.width / 2;
  const cy = metrics.height / 2;
  const hx = metrics.width / 2;
  const hy = metrics.height / 2;
  const distanceInside = -roundedRectSignedDistance(x + 0.5, y + 0.5, metrics);
  let dx = 0;
  let dy = 0;

  if (distanceInside >= 0 && distanceInside < metrics.band) {
    const epsilon = 0.75;
    const gx = (
      roundedRectSignedDistance(x + 0.5 + epsilon, y + 0.5, metrics) -
      roundedRectSignedDistance(x + 0.5 - epsilon, y + 0.5, metrics)
    ) / (2 * epsilon);
    const gy = (
      roundedRectSignedDistance(x + 0.5, y + 0.5 + epsilon, metrics) -
      roundedRectSignedDistance(x + 0.5, y + 0.5 - epsilon, metrics)
    ) / (2 * epsilon);
    const length = Math.hypot(gx, gy) || 1;
    const edgeT = Math.pow(1 - distanceInside / metrics.band, EDGE_EXPONENT);
    dx = (gx / length) * edgeT;
    dy = (gy / length) * edgeT;
  }

  if (distanceInside >= 0) {
    const edgeWeight = distanceInside < metrics.band ? 1 - distanceInside / metrics.band : 0;
    const k = INTERIOR_REFRACTION * (1 - Math.min(1, edgeWeight));
    dx += ((cx - (x + 0.5)) / hx) * k;
    dy += ((cy - (y + 0.5)) / hy) * k;
  }

  return { dx, dy };
}

export function encodeLiquidLensVector(vector: LensVector): { red: number; green: number; blue: 128; alpha: 255 } {
  return {
    red: clampByte(128 + vector.dx * 127),
    green: clampByte(128 + vector.dy * 127),
    blue: 128,
    alpha: 255,
  };
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function getReducedTransparencyMatcher(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  try {
    return window.matchMedia(REDUCED_TRANSPARENCY_QUERY);
  } catch {
    return null;
  }
}

function prefersReducedTransparency(): boolean {
  return getReducedTransparencyMatcher()?.matches ?? false;
}

export function isChromiumLensRuntime(): boolean {
  if (typeof navigator === "undefined") return false;
  return isChromiumUserAgent(navigator.userAgent);
}

export function isChromiumUserAgent(userAgent: string): boolean {
  const hasChromiumToken = /\b(?:Chrome|Chromium|HeadlessChrome|Edg|OPR)\//.test(userAgent);
  const isStandaloneSafari = /\bSafari\//.test(userAgent) && !hasChromiumToken;
  return hasChromiumToken && !/\bFirefox\//.test(userAgent) && !isStandaloneSafari;
}

function ensureLensDefs(): SVGDefsElement | null {
  if (defsElement?.isConnected) return defsElement;
  if (typeof document === "undefined" || !document.body) return null;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("data-liquid-lens-defs", "true");
  svg.style.position = "fixed";
  svg.style.inset = "0";
  svg.style.width = "0";
  svg.style.height = "0";
  svg.style.pointerEvents = "none";

  const defs = document.createElementNS(SVG_NS, "defs");
  svg.appendChild(defs);
  document.body.appendChild(svg);
  defsElement = defs;
  return defs;
}

function getElementLensId(element: HTMLElement): string {
  const existing = element.dataset.liquidLensId;
  if (existing) return existing;
  const id = `liquid-lens-${++lensUid}`;
  element.dataset.liquidLensId = id;
  return id;
}

function removeFilter(id: string | undefined): void {
  if (!id || typeof document === "undefined") return;
  document.getElementById(id)?.remove();
}

function buildLiquidLensMap(width: number, height: number, radius: number, band: number): string | null {
  if (typeof document === "undefined") return null;
  const size = calculateLiquidLensMapSize(width, height);
  const metrics: LiquidLensMapMetrics = {
    width: size.width,
    height: size.height,
    radius: radius / size.downsample,
    band: band / size.downsample,
  };
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  const image = context.createImageData(size.width, size.height);

  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      const offset = (y * size.width + x) * 4;
      const rgba = encodeLiquidLensVector(sampleLiquidLensVector(x, y, metrics));
      image.data[offset] = rgba.red;
      image.data[offset + 1] = rgba.green;
      image.data[offset + 2] = rgba.blue;
      image.data[offset + 3] = rgba.alpha;
    }
  }

  context.putImageData(image, 0, 0);
  return canvas.toDataURL();
}

export function cleanupLiquidLens(element: HTMLElement): void {
  removeFilter(element.dataset.liquidLensId);
  delete element.dataset.liquidLensId;
  element.style.backdropFilter = "";
  element.style.setProperty("-webkit-backdrop-filter", "");
}

export function applyLiquidLens(element: HTMLElement, options: LiquidLensOptions = {}): boolean {
  if (!isChromiumLensRuntime() || prefersReducedTransparency()) return false;

  const defs = ensureLensDefs();
  if (!defs) return false;

  const rect = element.getBoundingClientRect();
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  if (!width || !height) return false;

  const styles = getComputedStyle(element);
  const radius = Math.min(
    Number.parseFloat(styles.borderRadius) || 0,
    Math.min(width, height) / 2,
  );
  const band = Math.max(16, Math.min(56, Math.min(width, height) * 0.55));
  const id = getElementLensId(element);
  removeFilter(id);

  const map = buildLiquidLensMap(width, height, radius, band);
  if (!map) return false;

  const filter = document.createElementNS(SVG_NS, "filter");
  filter.setAttribute("id", id);
  filter.setAttribute("x", "0");
  filter.setAttribute("y", "0");
  filter.setAttribute("width", String(width));
  filter.setAttribute("height", String(height));
  filter.setAttribute("filterUnits", "userSpaceOnUse");
  filter.setAttribute("color-interpolation-filters", "sRGB");

  const image = document.createElementNS(SVG_NS, "feImage");
  image.setAttribute("href", map);
  image.setAttribute("x", "0");
  image.setAttribute("y", "0");
  image.setAttribute("width", String(width));
  image.setAttribute("height", String(height));
  image.setAttribute("preserveAspectRatio", "none");
  image.setAttribute("result", "map");

  const displacement = document.createElementNS(SVG_NS, "feDisplacementMap");
  displacement.setAttribute("in", "SourceGraphic");
  displacement.setAttribute("in2", "map");
  displacement.setAttribute("scale", String(options.scale ?? DEFAULT_LENS_SCALE));
  displacement.setAttribute("xChannelSelector", "R");
  displacement.setAttribute("yChannelSelector", "G");

  filter.append(image, displacement);
  defs.appendChild(filter);

  const filterValue = `url(#${id}) blur(0.9px) saturate(165%)`;
  element.style.backdropFilter = filterValue;
  element.style.setProperty("-webkit-backdrop-filter", filterValue);
  return true;
}

export function useLiquidLens(
  ref: RefObject<HTMLElement | null>,
  options: LiquidLensOptions = {},
): void {
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof window === "undefined") return undefined;

    let timeout: number | null = null;
    const media = getReducedTransparencyMatcher();

    const run = () => {
      timeout = null;
      if (options.enabled === false || prefersReducedTransparency() || !isChromiumLensRuntime()) {
        cleanupLiquidLens(element);
        return;
      }
      applyLiquidLens(element, options);
    };
    const schedule = () => {
      if (timeout != null) window.clearTimeout(timeout);
      timeout = window.setTimeout(run, RESIZE_DEBOUNCE_MS);
    };

    run();

    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(schedule);
    resizeObserver?.observe(element);
    media?.addEventListener?.("change", schedule);

    return () => {
      if (timeout != null) window.clearTimeout(timeout);
      resizeObserver?.disconnect();
      media?.removeEventListener?.("change", schedule);
      cleanupLiquidLens(element);
    };
  }, [ref, options.enabled, options.scale]);
}
