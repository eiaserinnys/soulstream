/** The image presentation already used in chat markdown. */
export function MarkdownImage({
  src,
  alt = "",
  ariaLabel,
  onOpen,
  onError,
  variant = "default",
  className,
  loading = "lazy",
}: {
  src?: string;
  alt?: string;
  ariaLabel?: string;
  onOpen?(src: string, alt: string, trigger: HTMLImageElement): void;
  onError?(src: string): void;
  variant?: "default" | "card-evidence" | "chatRefined";
  className?: string;
  loading?: "eager" | "lazy";
}) {
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

  return (
    <img
      src={src}
      alt={alt}
      className={classes}
      loading={loading}
      role={onOpen ? "button" : undefined}
      aria-label={onOpen ? ariaLabel : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onError={() => {
        if (src) onError?.(src);
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
}
