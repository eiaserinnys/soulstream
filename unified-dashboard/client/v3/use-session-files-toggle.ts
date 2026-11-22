import { useCallback, useRef, useState } from "react";

export function useSessionFilesToggle() {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLElement | null>(null);
  const positions = useRef(new Map<string, number>());
  const readScroll = useCallback((sessionId: string) => positions.current.get(sessionId) ?? 0, []);
  const saveScroll = useCallback((sessionId: string, position: number) => { positions.current.set(sessionId, position); }, []);
  const close = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
  }, []);
  const toggle = useCallback(() => {
    if (open) close();
    else { trigger.current = document.activeElement as HTMLElement | null; setOpen(true); }
  }, [close, open]);
  return { open, close, toggle, readScroll, saveScroll };
}
