import { useCallback, useEffect, useRef, useState } from "react";
import { mimeTypeForFileName } from "@soulstream/wire-schema/attachments";

const HEIC_MIME_TYPES = new Set(["image/heic", "image/heif"]);

function normalizedMimeType(mimeType: string | null | undefined): string {
  return mimeType?.trim().toLowerCase().split(";", 1)[0] ?? "";
}

/** True when the source is an SVG, the one image kind that must stay <img>-only. */
export function isSvgImageSource(
  mimeType: string | null | undefined,
  src?: string | null,
): boolean {
  if (normalizedMimeType(mimeType) === "image/svg+xml") return true;
  if (src) return mimeTypeForFileName(src) === "image/svg+xml";
  return false;
}

/** HEIC/HEIF by MIME type or by the file extension exposed in the URL. */
export function isHeicImageSource(
  mimeType: string | null | undefined,
  src?: string | null,
): boolean {
  if (HEIC_MIME_TYPES.has(normalizedMimeType(mimeType))) return true;
  const inferred = mimeTypeForFileName(src);
  return inferred !== null && HEIC_MIME_TYPES.has(inferred);
}

/**
 * Fetches the original bytes and decodes them with heic2any. The decoder is
 * loaded with a dynamic import so it stays out of the main bundle; only
 * browsers that cannot paint HEIC (everything but Safari) ever reach it.
 */
export async function decodeHeicToObjectUrl(src: string): Promise<string> {
  const response = await fetch(src, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`HEIC source request failed: ${response.status}`);
  const blob = await response.blob();
  const { default: heic2any } = await import("heic2any");
  const converted = await heic2any({ blob, toType: "image/jpeg", quality: 0.92 });
  const convertedBlob = Array.isArray(converted) ? converted[0] : converted;
  if (!(convertedBlob instanceof Blob)) throw new Error("HEIC decoder returned no image");
  return URL.createObjectURL(convertedBlob);
}

export interface HeicImageSource {
  /** The URL to paint. Becomes the decoded blob URL when the browser could not paint HEIC. */
  displaySrc: string | undefined;
  /** A decode attempt is running for the current source. */
  decoding: boolean;
  /** The decoder could not convert the current source. */
  decodeFailed: boolean;
  /**
   * Call from the image's error event. Returns true when the error is being
   * handled (decode started or already attempted) and must not be reported;
   * false when the source is not HEIC and the caller should report the error.
   */
  tryDecode(): boolean;
}

/** Shared HEIC fallback for <img> renderers that do not know whether the browser paints HEIC. */
export function useHeicImageSource(
  src: string | undefined,
  mimeType?: string | null,
): HeicImageSource {
  const [decoded, setDecoded] = useState<{ src: string; url: string } | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [decodingSrc, setDecodingSrc] = useState<string | null>(null);
  const attempted = useRef(new Set<string>());
  const objectUrl = useRef<string | null>(null);

  useEffect(() => () => {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
  }, []);

  useEffect(() => {
    setDecoded(null);
    setFailedSrc(null);
    setDecodingSrc(null);
    attempted.current.clear();
    if (objectUrl.current) {
      URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = null;
    }
  }, [src]);

  const tryDecode = useCallback((): boolean => {
    if (!src || !isHeicImageSource(mimeType, src)) return false;
    if (decoded?.src === src || failedSrc === src) return false;
    if (attempted.current.has(src)) return true;
    if (typeof window === "undefined") return false;
    attempted.current.add(src);
    setDecodingSrc(src);
    void decodeHeicToObjectUrl(src).then(url => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = url;
      setDecoded({ src, url });
      setDecodingSrc(null);
    }).catch(() => {
      setDecodingSrc(null);
      setFailedSrc(src);
    });
    return true;
  }, [src, mimeType, decoded, failedSrc]);

  return {
    displaySrc: decoded && decoded.src === src ? decoded.url : src,
    decoding: decodingSrc === src,
    decodeFailed: failedSrc === src,
    tryDecode,
  };
}
