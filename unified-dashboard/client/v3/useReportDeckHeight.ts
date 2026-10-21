import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
/** Measures unconstrained content; only a publication's pre-answer height survives a reply. */
export function useReportDeckHeight(root: RefObject<HTMLElement | null>, revision: unknown, sessionId: string, layoutKey = sessionId, maximumHeight?: number) {
  const [measurement, setMeasurement] = useState<{ revision: unknown; layoutKey: string; height: number }>();
  const [waitingForFont, setWaitingForFont] = useState(false);
  const checkedInitialFont = useRef(false), mounted = useRef(true);
  const holding = useRef(false), pressing = useRef(false), scrolling = useRef(false);
  const pending = useRef<{ revision: unknown; layoutKey: string; height: number } | undefined>(undefined);
  const beforeAnswer = useRef(new Map<string, number>());
  const readingPositions = useRef(new WeakMap<HTMLElement, { top: number; atBottom: boolean }>());
  const measureCurrent = useRef<() => void>(() => {});
  const previousLayout = useRef(layoutKey);
  const releaseIfSettled = useCallback(() => {
    holding.current = pressing.current || scrolling.current;
    if (!holding.current && pending.current) setMeasurement(pending.current);
  }, []);
  const reset = useCallback(() => { pressing.current = false; scrolling.current = false; releaseIfSettled(); }, [releaseIfSettled]);
  useLayoutEffect(() => {
    if (previousLayout.current !== layoutKey) { beforeAnswer.current.clear(); readingPositions.current = new WeakMap(); reset(); previousLayout.current = layoutKey; }
    const node = root.current;
    if (!node?.isConnected) { reset(); return; }
    let width = node.clientWidth;
    const position = (reading: HTMLElement) => ({ top: reading.scrollTop,
      atBottom: reading.scrollHeight > reading.clientHeight + 1 && Math.abs(reading.scrollHeight - reading.scrollTop - reading.clientHeight) <= 1 });
    const rememberScroll = (event: Event) => {
      const reading = event.target;
      if (reading instanceof HTMLElement && reading.classList.contains('pas-report-reading')) readingPositions.current.set(reading, position(reading));
    };
    node.addEventListener('scroll', rememberScroll, true);
    const measure = () => {
      if (!node.isConnected) return;
      if (width !== node.clientWidth) { width = node.clientWidth; beforeAnswer.current.clear(); reset(); }
      // Never measure through an old height or the scrollbar it temporarily creates.
      const oldHeight = node.style.height, oldMaximum = node.style.maxHeight;
      const readings = [...node.querySelectorAll<HTMLElement>('.pas-report-reading')];
      const positions = readings.map(reading => {
        const current = position(reading), previous = readingPositions.current.get(reading);
        // Content can grow before ResizeObserver fires. Retain the last bottom
        // position unless the user has moved away from it in the meantime.
        return { ...current, atBottom: current.atBottom || (previous?.atBottom === true && previous.top === current.top) };
      });
      node.style.height = 'auto'; node.style.maxHeight = 'none';
      const keys = new Set<string>();
      const sizes = [...node.querySelectorAll<HTMLElement>('.pas-report-sheet')].map(sheet => {
        const content = sheet.querySelector<HTMLElement>('.pas-report-content')!;
        const footer = sheet.querySelector<HTMLElement>('.pas-report-footer');
        const undo = sheet.querySelector<HTMLElement>('.pas-report-undo');
        const style = getComputedStyle(sheet), key = sheet.dataset.publication!;
        keys.add(key);
        const intrinsic = content.getBoundingClientRect().height + (footer?.getBoundingClientRect().height ?? 0)
          + (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0) + (footer ? parseFloat(style.rowGap) || 0 : 0)
          + (undo ? undo.getBoundingClientRect().height + (parseFloat(style.rowGap) || 0) : 0);
        if (sheet.dataset.answered !== 'true') beforeAnswer.current.set(key, intrinsic);
        return sheet.dataset.answered === 'true' ? beforeAnswer.current.get(key) ?? intrinsic : intrinsic;
      });
      for (const key of beforeAnswer.current.keys()) if (!keys.has(key)) beforeAnswer.current.delete(key);
      node.style.height = oldHeight; node.style.maxHeight = oldMaximum;
      readings.forEach((reading, index) => {
        reading.scrollTop = positions[index].atBottom ? reading.scrollHeight : positions[index].top;
        const composer = reading.querySelector<HTMLElement>('.pas-report-card-preview .v3-card-comment-dock');
        if (composer?.contains(document.activeElement)) {
          // Caret scrolling may have moved the viewport before this resize.
          reading.scrollTop += Math.max(0, composer.getBoundingClientRect().bottom - reading.getBoundingClientRect().bottom);
        }
        readingPositions.current.set(reading, position(reading));
      });
      pending.current = { revision, layoutKey, height: Math.ceil(Math.max(0, ...sizes)) + 2 };
      if (!holding.current) setMeasurement(pending.current);
      node.querySelectorAll<HTMLElement>('.pas-report-reading').forEach(reading => {
        reading.dataset.more = String(reading.scrollHeight - reading.scrollTop - reading.clientHeight > 1);
      });
    };
    measureCurrent.current = measure;
    // Gate only the first connected node, before paint. Later revisions and
    // portal changes keep the already visible deck visible.
    if (!checkedInitialFont.current) {
      checkedInitialFont.current = true;
      const fonts = document.fonts;
      if (fonts) {
        const style = getComputedStyle(node);
        const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        if (!fonts.check(font)) {
          setWaitingForFont(true);
          const done = () => {
            if (!mounted.current) return;
            beforeAnswer.current.clear();
            measureCurrent.current();
            setWaitingForFont(false);
          };
          void fonts.load(font).then(done, done);
        }
      }
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    node.querySelectorAll('.pas-report-content, .pas-report-footer, .pas-report-reading').forEach(child => observer.observe(child));
    return () => { observer.disconnect(); node.removeEventListener('scroll', rememberScroll, true); measureCurrent.current = () => {}; };
  }, [root, revision, sessionId, layoutKey, reset]);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    const fontsChanged = () => { if (active) { beforeAnswer.current.clear(); measureCurrent.current(); } };
    // Wait once per mount, not once per content revision. Later loadingdone
    // events represent actual font arrivals and use the current measurement.
    document.fonts?.ready.then(fontsChanged);
    document.fonts?.addEventListener('loadingdone', fontsChanged);
    return () => { mounted.current = false; active = false; document.fonts?.removeEventListener('loadingdone', fontsChanged); };
  }, []);
  useEffect(() => {
    const release = () => { pressing.current = false; releaseIfSettled(); };
    window.addEventListener('pointerup', release); window.addEventListener('pointercancel', release);
    return () => { window.removeEventListener('pointerup', release); window.removeEventListener('pointercancel', release); };
  }, [releaseIfSettled]);
  const height = measurement?.layoutKey === layoutKey && (measurement.revision === revision || holding.current) ? measurement.height : undefined;
  return {
    height, holding, waitingForFont, overflowing: maximumHeight !== undefined && height !== undefined && height > maximumHeight,
    hold: () => { pressing.current = true; holding.current = true; },
    startScroll: () => { scrolling.current = true; holding.current = true; },
    endScroll: () => { scrolling.current = false; releaseIfSettled(); },
  };
}
