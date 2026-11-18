// @vitest-environment jsdom
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
import {completedBounds,completedGridLayout} from '@seosoyoung/soul-ui/cards/completed-cards';
import {useCompletedCards,type CompletedBrowser,type CompletedPageLoader} from './use-completed-cards';
import {reviewCard} from './components-review-fixtures';
import {invalidateV3} from './v3-live-invalidation-plane';
(globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
it('keeps 7-day instants, local date exclusive end and existing paper widths',()=>{
 const now=Date.parse('2026-10-02T03:00:00Z');
 expect(completedBounds('7','','',now)).toEqual({completedFrom:'2026-09-25T03:00:00.000Z',completedBefore:'2026-10-02T03:00:00.000Z'});
 expect(completedBounds('custom','2026-10-01','2026-10-02',now)).toEqual({completedFrom:new Date('2026-10-01T00:00:00').toISOString(),completedBefore:new Date('2026-10-03T00:00:00').toISOString()});
 expect([390,600,1100].map(width=>completedGridLayout(width,256,8,8).columns)).toEqual([1,2,3]);
});
it('retains cards and count during a live refresh of the same query',async()=>{
 const now=vi.spyOn(Date,'now').mockReturnValue(1000000000);
 let resolve!:(value:{cards:typeof reviewCard[];nextCursor:null})=>void;
 const loader=vi.fn<CompletedPageLoader>().mockResolvedValueOnce({cards:[reviewCard],nextCursor:null}).mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
 let browser:CompletedBrowser;const host=document.createElement('div'),root=createRoot(host);
 function Probe(){browser=useCompletedCards(undefined,true,loader);return null;}
 await act(async()=>root.render(<Probe/>));expect(browser!.loaded).toBe(true);
 now.mockReturnValue(1000005000);
 await act(()=>invalidateV3('card'));
 expect(browser!.loaded).toBe(true);expect(browser!.cards).toHaveLength(1);
 await act(async()=>resolve({cards:[reviewCard],nextCursor:null}));
 await act(()=>root.unmount());now.mockRestore();
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
