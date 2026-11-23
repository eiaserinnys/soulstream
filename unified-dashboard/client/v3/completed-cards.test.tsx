// @vitest-environment jsdom
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
import {completedBounds,completedGridLayout} from '@seosoyoung/soul-ui/cards/completed-cards';
import {useCompletedCards,mergeCompletedRefresh,type CompletedBrowser,type CompletedPageLoader} from './use-completed-cards';
import {reviewCard} from './components-review-fixtures';
import {invalidateV3} from './v3-live-invalidation-plane';
(globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
it('keeps 7-day instants, local date exclusive end and existing paper widths',()=>{
 const now=Date.parse('2026-10-02T03:00:00Z');
 expect(completedBounds('7','','',now)).toEqual({completedFrom:'2026-09-25T03:00:00.000Z',completedBefore:'2026-10-02T03:00:00.000Z'});
 expect(completedBounds('custom','2026-10-01','2026-10-02',now)).toEqual({completedFrom:new Date('2026-10-01T00:00:00').toISOString(),completedBefore:new Date('2026-10-03T00:00:00').toISOString()});
 expect([390,600,1100].map(width=>completedGridLayout(width,256,8,8).columns)).toEqual([1,2,3]);
});
it('refreshes preset bounds while retaining cards and reuses those bounds for later pages',async()=>{
 vi.useFakeTimers();
 const now=vi.spyOn(Date,'now').mockReturnValue(1000000000);
 let resolve!:(value:{cards:typeof reviewCard[];nextCursor:string|null})=>void;
 const newCard={...reviewCard,id:'new-completed'};
 const loader=vi.fn<CompletedPageLoader>().mockResolvedValueOnce({cards:[reviewCard],nextCursor:null})
  .mockImplementationOnce(()=>new Promise(done=>{resolve=done;})).mockResolvedValueOnce({cards:[],nextCursor:null});
 let browser:CompletedBrowser;const host=document.createElement('div'),root=createRoot(host);
 function Probe(){browser=useCompletedCards(undefined,true,loader);return null;}
 await act(async()=>root.render(<Probe/>));expect(browser!.loaded).toBe(true);
 const resetKey=browser!.resetKey;
 now.mockReturnValue(1000005000);
 await act(()=>invalidateV3('card'));
 await act(async()=>vi.advanceTimersByTimeAsync(500));
 expect(browser!.resetKey).toBe(resetKey);
 expect(browser!.loaded).toBe(true);expect(browser!.cards).toHaveLength(1);
 expect(Date.parse(loader.mock.calls[1][0].completedBefore!)).toBeGreaterThan(Date.parse(loader.mock.calls[0][0].completedBefore!));
 await act(async()=>resolve({cards:[reviewCard,newCard],nextCursor:'next'}));
 expect(browser!.cards.map(card=>card.id)).toContain(newCard.id);
 now.mockReturnValue(1000010000);
 await act(async()=>browser!.loadMore());
 expect(loader.mock.calls[2][0]).toEqual({...loader.mock.calls[1][0],cursor:'next'});
 await act(()=>root.unmount());now.mockRestore();vi.useRealTimers();
});
it('merges a refreshed first page with the older loaded tail and its cursor',()=>{
 const card=(id:string,completedAt:string|null)=>({...reviewCard,id,completedAt});
 const newer=card('new','2026-11-19T12:00:00.000Z'), edge=card('edge','2026-11-19T11:00:00.000Z');
 const same=card('same','2026-11-19T11:00:00.000Z'), older=card('older','2026-11-19T10:00:00.000Z'), missing=card('missing',null);
 expect(mergeCompletedRefresh({cards:[newer,edge],nextCursor:'new-cursor'},{cards:[edge,same,older,missing],cursor:'old-cursor'})).toEqual({cards:[newer,edge,same,older,missing],cursor:'old-cursor'});
 expect(mergeCompletedRefresh({cards:[newer,edge],nextCursor:'new-cursor'},{cards:[newer],cursor:'old-cursor'})).toEqual({cards:[newer,edge],cursor:'new-cursor'});
 expect(mergeCompletedRefresh({cards:[newer],nextCursor:null},{cards:[older],cursor:'old-cursor'})).toEqual({cards:[newer],cursor:null});
});
it('finishes an in-flight next page before refreshing once after invalidation',async()=>{
 let resolve!:(value:{cards:typeof reviewCard[];nextCursor:string|null})=>void;
 const old={...reviewCard,id:'old',completedAt:'2026-11-18T00:00:00.000Z'};
 const fresh={...reviewCard,id:'fresh',completedAt:'2026-11-19T00:00:00.000Z'};
 const loader=vi.fn<CompletedPageLoader>().mockResolvedValueOnce({cards:[fresh],nextCursor:'next'})
  .mockImplementationOnce(()=>new Promise(done=>{resolve=done;})).mockResolvedValueOnce({cards:[fresh],nextCursor:'next-new'});
 let browser:CompletedBrowser;const host=document.createElement('div'),root=createRoot(host);
 function Probe(){browser=useCompletedCards(undefined,true,loader);return null;}
 await act(async()=>root.render(<Probe/>));
 await act(()=>browser!.loadMore());
 await act(()=>{invalidateV3('card');invalidateV3('folder');});expect(loader).toHaveBeenCalledTimes(2);
 await act(async()=>resolve({cards:[old],nextCursor:'tail'}));
 expect(loader).toHaveBeenCalledTimes(3);expect(browser!.cards.map(card=>card.id)).toEqual(['fresh','old']);
 expect(browser!.hasMore).toBe(true);
 await act(()=>root.unmount());
});
it('only reads done when shown and retains identical filters while deduplicating pages',async()=>{
 const loader=vi.fn<CompletedPageLoader>().mockResolvedValueOnce({cards:[reviewCard],nextCursor:'next'}).mockResolvedValueOnce({cards:[reviewCard,{...reviewCard,id:'second'}],nextCursor:null});
 let browser:CompletedBrowser;const host=document.createElement('div'),root=createRoot(host);
 function Probe({shown}:{shown:boolean}){browser=useCompletedCards(undefined,shown,loader);return null;}
 await act(async()=>root.render(<Probe shown={false}/>));expect(loader).not.toHaveBeenCalled();
 await act(async()=>root.render(<Probe shown/>));expect(browser!.cards).toHaveLength(1);
 await act(async()=>browser!.loadMore());expect(browser!.cards).toHaveLength(2);
 expect(loader.mock.calls[1][0]).toEqual({...loader.mock.calls[0][0],cursor:'next'});
 await act(()=>root.unmount());
});
it('marks the current query loaded only after its first response',async()=>{
 let resolve!:(value:{cards:typeof reviewCard[];nextCursor:null})=>void;
 const loader:CompletedPageLoader=()=>new Promise(done=>{resolve=done;});
 let browser:CompletedBrowser;const host=document.createElement('div'),root=createRoot(host);
 function Probe(){browser=useCompletedCards(undefined,true,loader);return null;}
 await act(()=>root.render(<Probe/>));expect(browser!.loaded).toBe(false);
 await act(async()=>resolve({cards:[reviewCard],nextCursor:null}));expect(browser!.loaded).toBe(true);
 await act(()=>browser!.setPeriod('30'));expect(browser!.loaded).toBe(false);
 await act(async()=>resolve({cards:[],nextCursor:null}));expect(browser!.loaded).toBe(true);
 await act(()=>root.unmount());
});
