"use client";

import { useTranslation } from "react-i18next";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { MoveHorizontal, MoveVertical, Shrink } from "lucide-react";
import { Button } from "./ui/button";
import { isSvgImageSource } from "../lib/image-source";

export type AttachmentImageView = { axis: "y" | "x"; frame: "column" | "full" };
export type AttachmentImageFit = "read" | "whole";
export type AttachmentImageState = "loading" | "ready" | "failed";

/**
 * Long captures read at a fit width instead of being shrunk to fit the whole
 * popup. The reading size is used only when fitting the whole image would make
 * its short side smaller than half of `min(referenceWidth, area.height)`; the
 * reference width is the phone-width frame's picture width (--container-md).
 * Tall images read at width fit with vertical scrolling, wide images at height
 * fit with horizontal scrolling, and neither mode upscales past 1:1.
 */
export function attachmentImageReadingFor(
  natural: { width: number; height: number },
  area: { width: number; height: number },
  referenceWidth: number,
): AttachmentImageView | null {
  const { width, height } = natural;
  if (width <= 0 || height <= 0 || area.width <= 0 || area.height <= 0 || referenceWidth <= 0) {
    return null;
  }
  const reference = Math.min(referenceWidth, area.height);
  const tall = height > width;
  const read = Math.min(1, reference / (tall ? width : height));
  const whole = Math.min(1, area.width / width, area.height / height);
  if (whole >= read / 2) return null;
  return tall ? { axis: "y", frame: "column" } : { axis: "x", frame: "full" };
}

function sizeKey(viewport: HTMLElement): string {
  return `${viewport.clientWidth}x${viewport.clientHeight}:${viewport.scrollWidth}x${viewport.scrollHeight}`;
}

export interface AttachmentImageViewer {
  state: AttachmentImageState;
  attempt: number;
  reading: AttachmentImageView | null;
  fit: AttachmentImageFit;
  format: "svg" | "raster";
  retryable: boolean;
  /** Attributes for the dialog popup: state, format and the reading frame. */
  popupAttributes: Record<string, string>;
  /** Natural-size custom properties used by the reading frame width. */
  popupStyle: CSSProperties;
  areaProbeRef: RefObject<HTMLSpanElement | null>;
  referenceProbeRef: RefObject<HTMLSpanElement | null>;
  viewportRef: RefObject<HTMLDivElement | null>;
  viewportProps: {
    role: "region";
    "aria-label": string;
    tabIndex: number;
    onScroll(): void;
  };
  onImageLoad(): void;
  onImageError(): void;
  retry(): void;
  toggleFit(): void;
  showToggle: boolean;
  toggleLabel: string;
  toggleIcon: "shrink" | "vertical" | "horizontal";
  scrollAreaProps: {
    "data-fit": AttachmentImageFit;
    "data-axis": "y" | "x";
  };
}

/**
 * Behaviour shared by the attachment viewer and the card image viewer: load
 * state, natural-size measurement, reading-size calculation, scroll-ratio
 * preservation, the first focus on the scroll viewport and the fit toggle.
 */
export function useAttachmentViewerImage(input: {
  popupRef: RefObject<HTMLElement | null>;
  mediaRef: RefObject<HTMLElement | null>;
  src: string | undefined;
  mimeType?: string | null;
  label: string;
}): AttachmentImageViewer {
  const { t } = useTranslation();
  const { popupRef, mediaRef, src, mimeType, label } = input;
  const [state, setState] = useState<AttachmentImageState>(src ? "loading" : "ready");
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [reading, setReading] = useState<AttachmentImageView | null>(null);
  const [fit, setFit] = useState<AttachmentImageFit>("read");
  const [attempt, setAttempt] = useState(0);
  const [retryable, setRetryable] = useState(false);
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const readingRef = useRef(reading);
  readingRef.current = reading;
  const scrollRatio = useRef(0);
  const scrollSize = useRef("");
  const areaProbeRef = useRef<HTMLSpanElement>(null);
  const referenceProbeRef = useRef<HTMLSpanElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setState(src ? "loading" : "ready");
    setNatural(null);
    setReading(null);
    setFit("read");
    setAttempt(0);
    setRetryable(false);
    scrollRatio.current = 0;
    scrollSize.current = "";
  }, [src]);

  const measure = useCallback((size: { width: number; height: number }) => {
    const areaRect = areaProbeRef.current?.getBoundingClientRect();
    const referenceRect = referenceProbeRef.current?.getBoundingClientRect();
    if (!areaRect || !referenceRect) return null;
    return attachmentImageReadingFor(
      size,
      { width: areaRect.width, height: areaRect.height },
      referenceRect.width,
    );
  }, []);

  const onImageLoad = useCallback(() => {
    const image = mediaRef.current?.querySelector("img");
    const size = image && image.naturalWidth > 0 && image.naturalHeight > 0
      ? { width: image.naturalWidth, height: image.naturalHeight }
      : null;
    if (size) {
      setNatural(size);
      // Decide the frame in the same render as the image so it never paints in
      // the whole-image layout first and then jumps into the reading frame.
      setReading(measure(size));
    }
    setState("ready");
  }, [mediaRef, measure]);

  const onImageError = useCallback(() => {
    setState("failed");
    setNatural(null);
    setReading(null);
    if (!src || src.startsWith("blob:")) {
      setRetryable(false);
      return;
    }
    // Image error events omit the HTTP status. Probe only a failed remote
    // source to offer retry for server/network failures, never for forbidden
    // or missing files.
    const controller = new AbortController();
    void fetch(src, { method: "HEAD", credentials: "same-origin", signal: controller.signal })
      .then(async response => {
        if (!controller.signal.aborted) setRetryable(response.status >= 500);
        await response.body?.cancel();
      }).catch(error => {
        if (!controller.signal.aborted && error instanceof TypeError) setRetryable(true);
      });
  }, [src]);

  const retry = useCallback(() => {
    setAttempt(value => value + 1);
    setState("loading");
    setNatural(null);
    setReading(null);
    setRetryable(false);
  }, []);

  const toggleFit = useCallback(() => {
    setFit(current => current === "read" ? "whole" : "read");
  }, []);

  const axis = reading?.axis ?? "y";
  const applyRatio = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || fitRef.current !== "read") return;
    scrollSize.current = sizeKey(viewport);
    const currentAxis = readingRef.current?.axis ?? "y";
    const max = currentAxis === "y"
      ? viewport.scrollHeight - viewport.clientHeight
      : viewport.scrollWidth - viewport.clientWidth;
    const position = Math.round(scrollRatio.current * Math.max(0, max));
    if (currentAxis === "y") viewport.scrollTop = position;
    else viewport.scrollLeft = position;
  }, []);

  // Returning from whole view restores the scroll ratio, and a resized window
  // keeps the same ratio.
  useLayoutEffect(() => {
    if (fit === "read") applyRatio();
  }, [fit, reading, applyRatio]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => applyRatio());
    observer.observe(viewport);
    const image = viewport.querySelector("img");
    if (image) observer.observe(image);
    // The window can settle its layout after the observer callback; run once
    // more on the next frame so the restored ratio uses the final scroll range.
    const reapply = () => window.requestAnimationFrame(() => applyRatio());
    window.addEventListener("resize", reapply);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", reapply);
    };
  }, [reading, applyRatio]);

  // When the reading frame appears, the first focus is the scroll area so the
  // arrow keys, PageDown and Space scroll it. Only move focus if it has not been
  // deliberately placed elsewhere (and never when the image is cached and the
  // frame settles before the dialog picks its initial focus).
  useEffect(() => {
    if (!reading) return;
    const moveInitialFocus = () => {
      const popup = popupRef.current;
      const active = document.activeElement;
      if (popup && (active === popup || active === document.body || active === null)) {
        viewportRef.current?.focus({ preventScroll: true });
      }
    };
    moveInitialFocus();
    const frame = window.requestAnimationFrame(moveInitialFocus);
    const timer = window.setTimeout(moveInitialFocus, 250);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [reading, popupRef]);

  const onViewportScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || fitRef.current !== "read" || sizeKey(viewport) !== scrollSize.current) return;
    const currentAxis = readingRef.current?.axis ?? "y";
    const max = currentAxis === "y"
      ? viewport.scrollHeight - viewport.clientHeight
      : viewport.scrollWidth - viewport.clientWidth;
    scrollRatio.current = max > 0
      ? (currentAxis === "y" ? viewport.scrollTop : viewport.scrollLeft) / max
      : 0;
  }, []);

  const format = isSvgImageSource(mimeType, src) ? "svg" : "raster";
  const readingActive = state === "ready" && reading !== null;
  const popupAttributes: Record<string, string> = {
    "data-image-state": state,
    "data-image-format": format,
    ...(readingActive ? { "data-image-frame": reading.frame, "data-image-fit": fit } : {}),
  };
  const popupStyle = natural === null ? {} : {
    "--attachment-natural-width": `${natural.width}px`,
    "--attachment-natural-height": `${natural.height}px`,
  } as CSSProperties;
  const toggleLabel = fit === "read"
    ? t("ui.attachment.fitImage")
    : reading?.axis === "x" ? t("ui.attachment.fitHeight") : t("ui.attachment.fitWidth");
  const toggleIcon = fit === "read"
    ? "shrink"
    : reading?.axis === "x" ? "vertical" : "horizontal";

  return {
    state,
    attempt,
    reading,
    fit,
    format,
    retryable,
    popupAttributes,
    popupStyle,
    areaProbeRef,
    referenceProbeRef,
    viewportRef,
    viewportProps: {
      role: "region",
      "aria-label": label,
      tabIndex: readingActive && fit === "read" ? 0 : -1,
      onScroll: onViewportScroll,
    },
    onImageLoad,
    onImageError,
    retry,
    toggleFit,
    showToggle: readingActive,
    toggleLabel,
    toggleIcon,
    scrollAreaProps: {
      "data-fit": fit,
      "data-axis": axis,
    },
  };
}

const TOGGLE_ICONS = {
  shrink: Shrink,
  vertical: MoveVertical,
  horizontal: MoveHorizontal,
} as const;

/** The fit toggle next to the dialog close button. Icon button, name in aria-label and title only. */
export function AttachmentViewerFitToggle({
  label,
  icon,
  onToggle,
}: {
  label: string;
  icon: "shrink" | "vertical" | "horizontal";
  onToggle(): void;
}) {
  const Icon = TOGGLE_ICONS[icon];
  return (
    <div className="attachment-viewer-actions">
      <Button size="icon" variant="ghost" aria-label={label} title={label} onClick={onToggle}>
        <Icon aria-hidden="true" />
      </Button>
    </div>
  );
}

/** Centred loading and failure states that replace the image in the same slot. */
export function AttachmentViewerImageStatus({
  state,
  message,
  retryable,
  onRetry,
}: {
  state: AttachmentImageState;
  message?: string | null;
  retryable: boolean;
  onRetry(): void;
}) {
  const { t } = useTranslation();
  if (state === "loading") {
    return <div className="attachment-viewer-state chat-image-status" role="status">{t("ui.attachment.imageLoading")}</div>;
  }
  if (state !== "failed") return null;
  return (
    <div className="attachment-viewer-state chat-image-status" role="status">
      {message ? <span data-slot="dialog-error-message">{message}</span> : null}
      {retryable && <Button variant="outline" size="sm" onClick={onRetry}>{t("ui.common.retry")}</Button>}
    </div>
  );
}

/** Invisible probes that expose the current picture limits and the phone-width reference. */
export function AttachmentViewerProbes({
  areaRef,
  referenceRef,
}: {
  areaRef: RefObject<HTMLSpanElement | null>;
  referenceRef: RefObject<HTMLSpanElement | null>;
}) {
  return (
    <span className="attachment-viewer-probes" aria-hidden="true">
      <span ref={areaRef} className="attachment-viewer-probe" />
      <span ref={referenceRef} className="attachment-viewer-probe attachment-viewer-probe-reference" />
    </span>
  );
}

