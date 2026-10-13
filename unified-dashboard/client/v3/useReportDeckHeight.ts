import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
/** Measures unconstrained content; only a publication's pre-answer height survives a reply. */
export function useReportDeckHeight(root: RefObject<HTMLElement | null>, revision: unknown, sessionId: string, layoutKey = sessionId, maximumHeight?: number) {
  const [measurement, setMeasurement] = useState<{ revision: unknown; layoutKey: string; height: number }>();
  const holding = useRef(false), pressing = useRef(false), scrolling = useRef(false);
  const pending = useRef<{ revision: unknown; layoutKey: string; height: number } | undefined>(undefined);
  const beforeAnswer = useRef(new Map<string, number>());
  const measureCurrent = useRef<() => void>(() => {});
  const previousLayout = useRef(layoutKey);
  const releaseIfSettled = useCallback(() => {
    holding.current = pressing.current || scrolling.current;
    if (!holding.current && pending.current) setMeasurement(pending.current);
  }, []);
  const reset = useCallback(() => { pressing.current = false; scrolling.current = false; releaseIfSettled(); }, [releaseIfSettled]);
  useLayoutEffect(() => {
    if (previousLayout.current !== layoutKey) { beforeAnswer.current.clear(); reset(); previousLayout.current = layoutKey; }
    const node = root.current;
    if (!node?.isConnected) { reset(); return; }
    let width = node.clientWidth;
    const measure = () => {
      if (!node.isConnected) return;
      if (width !== node.clientWidth) { width = node.clientWidth; beforeAnswer.current.clear(); reset(); }
      // Never measure through an old height or the scrollbar it temporarily creates.
      const oldHeight = node.style.height, oldMaximum = node.style.maxHeight;
      node.style.height = 'auto'; node.style.maxHeight = 'none';
      const keys = new Set<string>();
      const sizes = [...node.querySelectorAll<HTMLElement>('.pas-report-sheet')].map(sheet => {
        const content = sheet.querySelector<HTMLElement>('.pas-report-content')!;
        const footer = sheet.querySelector<HTMLElement>('.pas-report-footer');
        const style = getComputedStyle(sheet), key = sheet.dataset.publication!;
        keys.add(key);
        const intrinsic = content.getBoundingClientRect().height + (footer?.getBoundingClientRect().height ?? 0)
          + (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0) + (footer ? parseFloat(style.rowGap) || 0 : 0);
        if (sheet.dataset.answered !== 'true') beforeAnswer.current.set(key, intrinsic);
        return sheet.dataset.answered === 'true' ? beforeAnswer.current.get(key) ?? intrinsic : intrinsic;
      });
      for (const key of beforeAnswer.current.keys()) if (!keys.has(key)) beforeAnswer.current.delete(key);
      node.style.height = oldHeight; node.style.maxHeight = oldMaximum;
      pending.current = { revision, layoutKey, height: Math.ceil(Math.max(0, ...sizes)) + 2 };
      if (!holding.current) setMeasurement(pending.current);
      node.querySelectorAll<HTMLElement>('.pas-report-reading').forEach(reading => {
        reading.dataset.more = String(reading.scrollHeight - reading.scrollTop - reading.clientHeight > 1);
      });
    };
    measureCurrent.current = measure;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    node.querySelectorAll('.pas-report-content, .pas-report-footer, .pas-report-reading').forEach(child => observer.observe(child));
    return () => { observer.disconnect(); measureCurrent.current = () => {}; };
  }, [root, revision, sessionId, layoutKey, reset]);
  useEffect(() => {
    let active = true;
    const fontsChanged = () => { if (active) { beforeAnswer.current.clear(); measureCurrent.current(); } };
    // Wait once per mount, not once per content revision. Later loadingdone
    // events represent actual font arrivals and use the current measurement.
    document.fonts?.ready.then(fontsChanged);
    document.fonts?.addEventListener('loadingdone', fontsChanged);
    return () => { active = false; document.fonts?.removeEventListener('loadingdone', fontsChanged); };
  }, []);
  useEffect(() => {
    const release = () => { pressing.current = false; releaseIfSettled(); };
    window.addEventListener('pointerup', release); window.addEventListener('pointercancel', release);
    return () => { window.removeEventListener('pointerup', release); window.removeEventListener('pointercancel', release); };
  }, [releaseIfSettled]);
  const height = measurement?.layoutKey === layoutKey && (measurement.revision === revision || holding.current) ? measurement.height : undefined;
  return {
    height, holding, overflowing: maximumHeight !== undefined && height !== undefined && height > maximumHeight,
    hold: () => { pressing.current = true; holding.current = true; },
    startScroll: () => { scrolling.current = true; holding.current = true; },
    endScroll: () => { scrolling.current = false; releaseIfSettled(); },
  };
}
