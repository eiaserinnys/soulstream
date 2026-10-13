import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
/** Measure intrinsic pages; retain an answered publication's height without scrollable blanks. */
export function useReportDeckHeight(root: RefObject<HTMLElement | null>, revision: unknown, sessionId: string) {
  const [height, setHeight] = useState<number>();
  const holding = useRef(false);
  const pressing = useRef(false);
  const scrolling = useRef(false);
  const pending = useRef<number | undefined>(undefined);
  const measured = useRef(new Map<string, number>());
  useLayoutEffect(() => { measured.current.clear(); }, [sessionId]);
  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    let width = node.clientWidth;
    const measure = () => {
      if (width !== node.clientWidth) { width = node.clientWidth; measured.current.clear(); }
      const sizes = [...node.querySelectorAll<HTMLElement>('.pas-report-sheet')].map(sheet => {
        const content = sheet.querySelector<HTMLElement>('.pas-report-content')!;
        const footer = sheet.querySelector<HTMLElement>('.pas-report-footer');
        const style = getComputedStyle(sheet);
        const intrinsic = content.getBoundingClientRect().height + (footer?.getBoundingClientRect().height ?? 0)
          + (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0) + (footer ? parseFloat(style.rowGap) || 0 : 0);
        const key = `${sheet.dataset.publication}|${width}`;
        const size = Math.max(intrinsic, measured.current.get(key) ?? 0);
        measured.current.set(key, size);
        return size;
      });
      node.querySelectorAll<HTMLElement>('.pas-report-reading').forEach(reading => {
        reading.dataset.more = String(reading.scrollHeight - reading.scrollTop - reading.clientHeight > 1);
      });
      const next = Math.ceil(Math.max(0, ...sizes)) + 2; // existing one-pixel border on both edges
      pending.current = next;
      if (!holding.current) setHeight(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    node.querySelectorAll('.pas-report-content, .pas-report-footer').forEach(child => observer.observe(child));
    return () => observer.disconnect();
  }, [root, revision]);
  const releaseIfSettled = useCallback(() => {
    holding.current = pressing.current || scrolling.current;
    if (!holding.current && pending.current !== undefined) setHeight(pending.current);
  }, []);
  useEffect(() => {
    const release = () => { pressing.current = false; releaseIfSettled(); };
    window.addEventListener('pointerup', release); window.addEventListener('pointercancel', release);
    return () => { window.removeEventListener('pointerup', release); window.removeEventListener('pointercancel', release); };
  }, [releaseIfSettled]);
  return {
    height, holding,
    hold: () => { pressing.current = true; holding.current = true; },
    startScroll: () => { scrolling.current = true; holding.current = true; },
    endScroll: () => { scrolling.current = false; releaseIfSettled(); },
  };
}
