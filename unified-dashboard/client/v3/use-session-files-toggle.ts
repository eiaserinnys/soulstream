import { useCallback, useRef, useState } from "react";

export function useSessionFilesToggle() {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLElement | null>(null);
  const close = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
  }, []);
  const toggle = useCallback(() => {
    if (open) close();
    else { trigger.current = document.activeElement as HTMLElement | null; setOpen(true); }
  }, [close, open]);
  return { open, close, toggle };
}
