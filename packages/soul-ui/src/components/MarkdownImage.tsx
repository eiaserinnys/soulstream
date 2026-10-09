import { useState } from "react";

/** The image presentation already used in chat markdown. */
export function MarkdownImage({
  src,
  alt = "",
  ariaLabel,
  onOpen,
  onLoad,
  onError,
  variant = "default",
  className,
  loading = "lazy",
}: {
  src?: string;
  alt?: string;
  ariaLabel?: string;
  onOpen?(src: string, alt: string, trigger: HTMLImageElement): void;
  onLoad?(src: string): void;
  onError?(src: string): void;
  variant?: "default" | "card-evidence" | "chatRefined";
  className?: string;
  loading?: "eager" | "lazy";
}) {
  const [loadState, setLoadState] = useState<{
    src: string | undefined;
    status: "loading" | "loaded" | "error";
  }>({ src, status: "loading" });
  const isChatRefined = variant === "chatRefined";
  const loadStatus = !src
    ? "loaded"
    : loadState.src === src
      ? loadState.status
      : "loading";
  const classes = [
    "max-w-full rounded my-1.5",
    variant === "card-evidence" ? "v3-card-evidence-image" : "",
    variant === "chatRefined" ? "chat-image-refined" : "",
    onOpen ? "outline-none focus-visible:ring-2 focus-visible:ring-ring" : "",
    className ?? "",
  ].filter(Boolean).join(" ");

  const open = (trigger: HTMLImageElement) => {
    if (src) onOpen?.(src, alt, trigger);
  };

  const image = (
    <img
      src={src}
      alt={alt}
      className={classes}
      loading={loading}
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
    <div className="chat-image-frame">
      {image}
      {loadStatus === "loading" && (
        <span className="chat-image-status" role="status">이미지 불러오는 중…</span>
      )}
    </div>
  );
}
