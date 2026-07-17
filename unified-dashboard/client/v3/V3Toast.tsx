import { createPortal } from "react-dom";

export function V3Toast({ message }: { message: string | null }) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className={`v3-toast${message ? " is-visible" : ""}`} role="status" aria-live="polite">
      {message}
    </div>,
    document.body,
  );
}
