/** @vitest-environment jsdom */
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useReportDeckHeight } from './useReportDeckHeight';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement; let root: ReturnType<typeof createRoot>; let sizing: ReturnType<typeof useReportDeckHeight>;
function Harness({ contentHeight }: { contentHeight: number }) {
  const ref = useRef<HTMLElement | null>(null); sizing = useReportDeckHeight(ref, contentHeight, 'a');
  return <section ref={ref} inert={sizing.waitingForFont || undefined} aria-hidden={sizing.waitingForFont || undefined} style={{ height: sizing.height, opacity: sizing.waitingForFont ? 0 : undefined, fontStyle: "normal", fontWeight: "400", fontSize: "14px", fontFamily: "ReportTest" }} onScrollEnd={sizing.endScroll}>{[contentHeight, Math.max(0, contentHeight - 50)].map((height, index) => <article key={index} className="pas-report-sheet" data-publication={`${contentHeight}-${index}`} style={{ paddingTop: 12, paddingBottom: 16, rowGap: 12 }}><div className="pas-report-reading"><div className="pas-report-content" data-height={height}/></div><div className="pas-report-footer" data-height="32"/></article>)}</section>;
}
const render = (height: number) => act(async () => root.render(<Harness contentHeight={height}/>));
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) { return { height: Number(this.dataset.height ?? 0) } as DOMRect; });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); Reflect.deleteProperty(document,'fonts'); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('holds updated heights from pointer down through horizontal settling, including release outside the deck', async () => {
  await render(100); expect(host.firstElementChild?.getAttribute('style')).toContain('174px');
  sizing.hold(); sizing.startScroll(); await render(200);
  window.dispatchEvent(new Event('pointerup')); expect(host.firstElementChild?.getAttribute('style')).toContain('174px');
  act(() => host.firstElementChild!.dispatchEvent(new Event('scrollend'))); expect(host.firstElementChild?.getAttribute('style')).toContain('274px');
});
it('holds smooth pagination without a pointer and releases an ordinary press as soon as it ends', async () => {
  await render(100); sizing.startScroll(); await render(200); expect(sizing.height).toBe(174);
  act(() => host.firstElementChild!.dispatchEvent(new Event('scrollend'))); expect(sizing.height).toBe(274);
  sizing.hold(); await render(300); expect(sizing.height).toBe(274);
  act(() => window.dispatchEvent(new Event('pointerup'))); expect(sizing.height).toBe(374);
});

it('restores each reading column scroll position after measuring a new revision', async () => {
  await render(100);
  const readings = [...host.querySelectorAll<HTMLElement>('.pas-report-reading')];
  const tops = [431, 173];
  const writes = readings.map((reading, index) => {
    let current = tops[index]!;
    Object.defineProperty(reading, 'scrollTop', { configurable: true, get: () => current, set: value => { current = value; } });
    return vi.spyOn(reading, 'scrollTop', 'set');
  });
  await render(200);
  expect(readings.map(reading => reading.scrollTop)).toEqual(tops);
  expect(writes.map(write => write.mock.calls.at(-1)?.[0])).toEqual(tops);
});

it('measures before showing after font success or failure, shows cached fonts immediately, and never hides again', async () => {
  for (const outcome of ['success', 'failure', 'cached'] as const) {
    let finish!: () => void, fail!: () => void;
    const load = vi.fn(() => new Promise<void>((resolve, reject) => { finish = resolve; fail = () => reject(new Error('font unavailable')); }));
    const check = vi.fn(() => outcome === 'cached');
    Object.defineProperty(document, 'fonts', { configurable: true, value: { check, load, ready: new Promise(() => {}), addEventListener: vi.fn(), removeEventListener: vi.fn() } });
    await render(300);
    expect(check).toHaveBeenCalledWith('normal 400 14px ReportTest');
    const deck = host.firstElementChild as HTMLElement;
    if (outcome === 'cached') {
      expect(deck.style.opacity).toBe(''); expect(load).not.toHaveBeenCalled();
    } else {
      expect(deck.style.opacity).toBe('0'); expect(deck.hasAttribute('inert')).toBe(true); expect(deck.getAttribute('aria-hidden')).toBe('true');
      // The actual font changes the intrinsic height before the pending load settles.
      deck.querySelectorAll<HTMLElement>('.pas-report-content').forEach(content => { content.dataset.height = '100'; });
      await act(async () => outcome === 'success' ? finish() : fail());
      expect(sizing.height).toBe(174); expect(deck.style.opacity).toBe(''); expect(deck.hasAttribute('inert')).toBe(false); expect(deck.hasAttribute('aria-hidden')).toBe(false);
    }
    await render(100); expect(sizing.height).toBe(174); expect(deck.style.opacity).toBe(''); expect(check).toHaveBeenCalledTimes(1);
    act(() => root.unmount()); root = createRoot(host);
  }
});

it('preserves answered A across timestamp changes and B updates, and drops A when its content changes',async()=>{
  Object.defineProperty(document,'fonts',{configurable:true,value:{check:()=>true,ready:Promise.resolve(),addEventListener:vi.fn(),removeEventListener:vi.fn()}});
  function Publications({answered=false,aUpdated='first',bUpdated='first',aContent='original'}:{answered?:boolean;aUpdated?:string;bUpdated?:string;aContent?:string}){
    const ref=useRef<HTMLElement|null>(null); sizing=useReportDeckHeight(ref,JSON.stringify([aUpdated,bUpdated,aContent]),'a');
    return <section ref={ref} style={{height:sizing.height}}>{[['A',aContent,answered?80:300,answered],['B','original',100,false]].map(([key,updated,height,answer])=><article key={String(key)} className="pas-report-sheet" data-publication={JSON.stringify(['a',key,updated])} data-answered={answer} style={{paddingTop:12,paddingBottom:16,rowGap:12}}><div className="pas-report-content" data-height={height}/><div className="pas-report-footer" data-height="32"/></article>)}</section>;
  }
  await act(async()=>root.render(<Publications/>)); expect(sizing.height).toBe(374);
  await act(async()=>root.render(<Publications answered/>));
  await act(async()=>root.render(<Publications answered bUpdated="new"/>)); expect(sizing.height).toBe(374);
  await act(async()=>root.render(<Publications answered aUpdated="server-answered" bUpdated="new"/>)); expect(sizing.height).toBe(374);
  await act(async()=>root.render(<Publications answered aUpdated="rewritten" aContent="new" bUpdated="new"/>)); expect(sizing.height).toBe(174);
});
