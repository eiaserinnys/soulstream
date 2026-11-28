import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import { isSvgImageSource, useHeicImageSource } from "../lib/image-source";

/** The image presentation already used in chat markdown. */
export function MarkdownImage({
  src,
  alt = "",
  ariaLabel,
  mimeType,
  onOpen,
  onLoad,
  onError,
  variant = "default",
  className,
  frameClassName,
  loading = "lazy",
}: {
  src?: string;
  alt?: string;
  ariaLabel?: string;
  /** Lets HEIC sources fall back to the lazily loaded decoder when the browser cannot paint them. */
  mimeType?: string | null;
  onOpen?(src: string, alt: string, trigger: HTMLImageElement): void;
  onLoad?(src: string): void;
  onError?(src: string): void;
  variant?: "default" | "card-evidence" | "chatRefined";
  className?: string;
  frameClassName?: string;
  loading?: "eager" | "lazy";
}) {
  const { t } = useTranslation();
  const [loadState, setLoadState] = useState<{
    src: string | undefined;
    status: "loading" | "loaded" | "error";
  }>({ src, status: "loading" });
  const heic = useHeicImageSource(src, mimeType);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const isChatRefined = variant === "chatRefined";
  const loadStatus = !src
    ? "loaded"
    : loadState.src === src
      ? loadState.status
      : "loading";
  const classes = [
    "max-w-full rounded-floor my-1.5",
    variant === "card-evidence" ? "v3-card-evidence-image" : "",
    variant === "chatRefined" ? "chat-image-refined" : "",
    onOpen ? "outline-none focus-visible:ring-2 focus-visible:ring-ring" : "",
    className ?? "",
  ].filter(Boolean).join(" ");

  const open = (trigger: HTMLImageElement) => {
    if (src) onOpen?.(src, alt, trigger);
  };

  // The decoder also fails after the <img> error event has already passed, so
  // report the failure from here instead of the event handler.
  useEffect(() => {
    if (!src || !heic.decodeFailed) return;
    if (isChatRefined) setLoadState({ src, status: "error" });
    onErrorRef.current?.(src);
  }, [heic.decodeFailed, src, isChatRefined]);

  const image = (
    <img
      src={heic.displaySrc}
      alt={alt}
      className={classes}
      loading={loading}
      data-image-format={isSvgImageSource(mimeType, src) ? "svg" : undefined}
      role={onOpen ? "button" : undefined}
      aria-label={onOpen ? ariaLabel : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onLoad={() => {
        if (!src) return;
        if (isChatRefined) setLoadState({ src, status: "loaded" });
        onLoad?.(src);
      }}
      onError={() => {
        if (!src) return;
        // A browser that cannot paint HEIC reports an error first; hand the
        // source to the decoder and report only if that also fails.
        if (heic.tryDecode()) return;
        if (isChatRefined) setLoadState({ src, status: "error" });
        onError?.(src);
      }}
      onClick={onOpen ? event => {
        event.stopPropagation();
        open(event.currentTarget);
      } : undefined}
      onKeyDown={onOpen ? event => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          open(event.currentTarget);
        }
      } : undefined}
    />
  );

  if (!isChatRefined) return image;

  return (
    <div className={["chat-image-frame", frameClassName ?? ""].filter(Boolean).join(" ")}>
      {image}
      {loadStatus === "loading" && (
        <span className="chat-image-status" role="status">{t("ui.attachment.imageLoading")}</span>
      )}
    </div>
  );
}
