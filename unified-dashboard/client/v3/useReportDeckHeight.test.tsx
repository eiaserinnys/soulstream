/** @vitest-environment jsdom */
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useReportDeckHeight } from './useReportDeckHeight';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement; let root: ReturnType<typeof createRoot>; let sizing: ReturnType<typeof useReportDeckHeight>;
function Harness({ contentHeight }: { contentHeight: number }) {
  const ref = useRef<HTMLElement | null>(null); sizing = useReportDeckHeight(ref, contentHeight, 'a');
  return <section ref={ref} style={{ height: sizing.height }} onScrollEnd={sizing.endScroll}><article className="pas-report-sheet" data-publication={contentHeight} style={{ paddingTop: 12, paddingBottom: 16, rowGap: 12 }}><div className="pas-report-content" data-height={contentHeight}/><div className="pas-report-footer" data-height="32"/></article></section>;
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

it('discards earlier larger measurements when content shrinks', async () => {
  await render(300); expect(sizing.height).toBe(374); await render(100); expect(sizing.height).toBe(174);
});

it('preserves answered A when only B changes, and drops A on its own new publication',async()=>{
  Object.defineProperty(document,'fonts',{configurable:true,value:{ready:Promise.resolve(),addEventListener:vi.fn(),removeEventListener:vi.fn()}});
  function Publications({answered=false,aUpdated='first',bUpdated='first'}:{answered?:boolean;aUpdated?:string;bUpdated?:string}){
    const ref=useRef<HTMLElement|null>(null); sizing=useReportDeckHeight(ref,JSON.stringify([aUpdated,bUpdated]),'a');
    return <section ref={ref} style={{height:sizing.height}}>{[['A',aUpdated,answered?80:300,answered],['B',bUpdated,100,false]].map(([key,updated,height,answer])=><article key={String(key)} className="pas-report-sheet" data-publication={JSON.stringify(['a',key,updated])} data-answered={answer} style={{paddingTop:12,paddingBottom:16,rowGap:12}}><div className="pas-report-content" data-height={height}/><div className="pas-report-footer" data-height="32"/></article>)}</section>;
  }
  await act(async()=>root.render(<Publications/>)); expect(sizing.height).toBe(374);
  await act(async()=>root.render(<Publications answered/>));
  await act(async()=>root.render(<Publications answered bUpdated="new"/>)); expect(sizing.height).toBe(374);
  await act(async()=>root.render(<Publications answered aUpdated="new" bUpdated="new"/>)); expect(sizing.height).toBe(174);
});
