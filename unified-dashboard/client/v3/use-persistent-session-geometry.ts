import { useLayoutEffect, useState, type RefObject } from 'react';
import { calculatePersistentSessionLayout, type PersistentSessionLayout } from '@seosoyoung/soul-ui/lib/persistent-session-layout';

type ElementRef = RefObject<HTMLElement | null>;
/** All observations share one frame and the same usable viewport coordinates. */
export function usePersistentSessionGeometry({ app, header, main, composer, enabled, showCharacter }: {
  app: ElementRef; header: ElementRef; main: ElementRef; composer: ElementRef;
  enabled: boolean; showCharacter: boolean;
}) {
  const [geometry, setGeometry] = useState<(PersistentSessionLayout & { mainLeft: number; mainWidth: number }) | null>(null);
  useLayoutEffect(() => {
    if (!enabled || !app.current || !header.current || !main.current || !composer.current) return;
    const pointer = window.matchMedia('(pointer: fine)');
    let frame: number | null = null;
    const measure = () => {
      frame = null;
      const appRect = app.current!.getBoundingClientRect();
      const headerRect = header.current!.getBoundingClientRect();
      const mainRect = main.current!.getBoundingClientRect();
      const composerElement = composer.current!.querySelector<HTMLElement>('[data-slot="chat-input-composer"]')!;
      const baselineBottom = composerElement.getBoundingClientRect().bottom;
      const rowBottomGap = Number.parseFloat(getComputedStyle(composerElement).paddingBottom) || 0;
      const inputRowHeight = composerElement.querySelector('[data-testid="send-button"]')?.getBoundingClientRect().height ?? 0;
      const style = getComputedStyle(app.current!);
      const safeBottom = parseFloat(style.paddingBottom) || 0;
      const viewportBottom = window.visualViewport ? window.visualViewport.offsetTop + window.visualViewport.height : appRect.bottom;
      const usableApp = { left: appRect.left, top: appRect.top, width: appRect.width, height: Math.min(appRect.bottom, viewportBottom) - appRect.top - safeBottom };
      setGeometry({ ...calculatePersistentSessionLayout({ app: usableApp, header: headerRect, main: mainRect, baselineBottom, inputRowHeight, rowBottomGap, pointerFine: pointer.matches, showCharacter, phoneConfigured: false }), mainLeft: mainRect.left - appRect.left, mainWidth: mainRect.width });
    };
    const schedule = () => { if (frame === null) frame = requestAnimationFrame(measure); };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    for (const ref of [app, header, main, composer]) observer?.observe(ref.current!);
    pointer.addEventListener('change', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    schedule();
    return () => {
      observer?.disconnect(); if (frame !== null) cancelAnimationFrame(frame);
      pointer.removeEventListener('change', schedule);
      window.visualViewport?.removeEventListener('resize', schedule); window.visualViewport?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [app, header, main, composer, enabled, showCharacter]);
  return enabled ? geometry : null;
}
