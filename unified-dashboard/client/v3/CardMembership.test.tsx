// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CardInboxBoard } from "./CardInboxBoard";
import { FolderCardSection } from "./FolderCardSection";
import { acceptV3SessionStreamEvent, resetV3InvalidationForTest } from "./v3-live-invalidation-plane";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import type { CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { reviewCard, reviewDetail } from "./components-review-fixtures";
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let element:HTMLDivElement,root:Root;
beforeEach(()=>{vi.useFakeTimers();vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}});vi.stubGlobal("matchMedia",(query:string)=>({matches:false,media:query,onchange:null,addListener:vi.fn(),removeListener:vi.fn(),addEventListener:vi.fn(),removeEventListener:vi.fn(),dispatchEvent:vi.fn()}));resetV3InvalidationForTest();useCardStore.getState().reset();element=document.createElement("div");document.body.append(element);root=createRoot(element);});
afterEach(async()=>{await act(()=>root.unmount());element.remove();vi.unstubAllGlobals();vi.useRealTimers();});
const row=(id:string)=>({...reviewCard,id,status:"todo" as const});
const response=(cards:typeof reviewCard[])=>new Response(JSON.stringify({cards}),{status:200});
const event=()=>acceptV3SessionStreamEvent({type:"card_updated",cardId:"new",folderId:reviewCard.folderId});
const flushWindow=async()=>act(async()=>vi.advanceTimersByTimeAsync(500));
it("keeps folder controls but hides unknown membership in both views and restores the board on retry",async()=>{
 let finish!:(value:Response)=>void;
 const fetch=vi.fn().mockImplementationOnce(()=>new Promise<Response>(resolve=>{finish=resolve;})).mockResolvedValue(response([row("loaded")]));
 vi.stubGlobal("fetch",fetch);
 await act(()=>root.render(<FolderCardSection folderId={reviewCard.folderId}/>));
 const checkUnknown=()=>{
  expect(element.textContent).not.toMatch(/\d+개 표시|카드가 없습니다/);
  expect(element.querySelector('.v3-card-board')).toBeNull();
  expect(element.querySelector('button[aria-label="보드 확대"]')).toBeNull();
 };
 checkUnknown();expect(element.querySelector('[role="status"]')?.textContent).toContain("카드를 불러오는 중…");
 await act(()=>element.querySelector<HTMLButtonElement>('button[aria-label="일반 보기"]')!.click());
 checkUnknown();expect(element.querySelector('.v3-postit-grid')).toBeNull();
 await act(async()=>finish(new Response(JSON.stringify({message:"실패"}),{status:500})));
 checkUnknown();expect(element.querySelector('[role="alert"]')).not.toBeNull();expect(element.querySelector('[role="status"]')).toBeNull();
 await act(()=>element.querySelector<HTMLButtonElement>('button[aria-label="보드"]')!.click());
 checkUnknown();
 await act(async()=>{[...element.querySelectorAll('button')].find(button=>button.textContent==="다시 불러오기")!.click();});
 expect(element.querySelector('.v3-card-board')).not.toBeNull();expect(element.querySelector('button[aria-label="보드 확대"]')).not.toBeNull();
 expect(element.textContent).toContain("1개 표시");
});
it("keeps the known folder board when a later refresh fails",async()=>{
 let fail=false;vi.stubGlobal("fetch",vi.fn(async()=>{if(fail)throw new Error("connection lost");return response([row("known")]);}));
 await act(async()=>root.render(<FolderCardSection folderId={reviewCard.folderId}/>));
 fail=true;await act(async()=>event());
 await flushWindow();
 expect(element.querySelector('[role="alert"]')).not.toBeNull();expect(element.querySelector('[data-card-id="known"]')).not.toBeNull();
 expect(element.querySelector('button[aria-label="보드 확대"]')).not.toBeNull();expect(element.textContent).toContain("1개 표시");
});
it("refetches authorized global membership on SSE, coalesces duplicates and removes deleted, archived and cancelled cards",async()=>{
 let rows:CardRow[]=[row("old")];const fetch=vi.fn(async()=>response(rows));vi.stubGlobal("fetch",fetch);
 useCardStore.getState().putCards([row("unlisted")]);
 await act(async()=>{root.render(<CardInboxBoard/>);});
 expect(element.querySelector('[data-card-id="old"]')).not.toBeNull();
 rows=[row("new"),row("new"),{...row("archived"),archived:true},{...row("cancelled"),status:"cancelled"}];
 await act(async()=>{event();event();});
 await flushWindow();
 expect(element.querySelectorAll('[data-card-id="new"]')).toHaveLength(1);
 expect(element.querySelector('[data-card-id="old"]')).toBeNull();expect(element.querySelector('[data-card-id="unlisted"]')).toBeNull();
 expect(element.querySelector('[data-card-id="archived"]')).toBeNull();expect(element.querySelector('[data-card-id="cancelled"]')).toBeNull();
 expect(element.querySelector('.v3-folder-card-head')?.textContent).toContain("1개");expect(fetch).toHaveBeenCalledTimes(2);
});
it("does not publish a pre-replay initial list or an old folder response into the new scope",async()=>{
 const resolve:((value:Response)=>void)[]=[];const fetch=vi.fn(()=>new Promise<Response>(done=>resolve.push(done)));vi.stubGlobal("fetch",fetch);
 await act(()=>root.render(<FolderCardSection folderId="first"/>));
 await act(()=>acceptV3SessionStreamEvent({type:"replay_gap",latest_id:5,instance_id:"orch"}));
 await act(async()=>resolve[0](response([{...row("stale"),folderId:"first"}])));
 await flushWindow();
 expect(element.querySelector('[data-card-id="stale"]')).toBeNull();expect(fetch).toHaveBeenCalledTimes(2);
 await act(()=>root.render(<FolderCardSection folderId="second"/>));
 await act(async()=>resolve[1](response([{...row("wrong-scope"),folderId:"first"}])));
 await act(async()=>resolve[2](response([{...row("current"),folderId:"second"},{...row("done"),folderId:"second",status:"done"}])));
 expect(element.querySelector('[data-card-id="wrong-scope"]')).toBeNull();expect(element.querySelector('[data-card-id="current"]')).not.toBeNull();
 expect(element.querySelector('[data-card-id="done"]')).toBeNull();expect(element.querySelector('[data-board-column="done"]')).toBeNull();
});
it("removes folder move-outs and updates visible status without exposing cached cards outside the list",async()=>{
 let rows:CardRow[]=[row("moving")];vi.stubGlobal("fetch",vi.fn(async()=>response(rows)));
 await act(async()=>root.render(<FolderCardSection folderId={reviewCard.folderId}/>));
 rows=[{...row("incoming"),status:"review"}];
 await act(async()=>{useCardStore.getState().putCards([{...row("moving"),folderId:"elsewhere"},row("unlisted")]);event();});
 await flushWindow();
 expect(element.querySelector('[data-card-id="moving"]')).toBeNull();expect(element.querySelector('[data-card-id="incoming"][data-card-status="review"]')).not.toBeNull();
 expect(element.querySelector('[data-card-id="unlisted"]')).toBeNull();
 rows=[{...row("incoming"),status:"done",version:reviewCard.version+1}];await act(async()=>event());await flushWindow();
 expect(element.querySelector('[data-card-id="incoming"]')).toBeNull();expect(element.querySelector('[data-board-column="done"]')).toBeNull();
});

it("keeps an open status menu and expanded board through an SSE list refetch failure",async()=>{
 let fail=false;const card={...reviewCard,status:"review" as const};
 vi.stubGlobal("fetch",vi.fn(async(url:string)=>{if(url===`/api/cards/${card.id}`)return new Response(JSON.stringify({...reviewDetail,card}));if(fail)throw new Error("connection lost");return response([card]);}));
 await act(async()=>root.render(<CardInboxBoard/>));
 await act(()=>element.querySelector<HTMLButtonElement>('button[aria-label="보드 확대"]')!.click());
 await act(async()=>{element.querySelector<HTMLButtonElement>('button[aria-label="카드 상태 변경"]')!.click();});
 fail=true;await act(async()=>event());
 await flushWindow();
 expect(document.querySelector('[data-card-status-picker]')).not.toBeNull();
 expect(element.querySelector('[data-card-board-expanded="true"]')).not.toBeNull();
});

it("bounds a stream of spaced events and refreshes replay immediately",async()=>{
 const fetch=vi.fn(async()=>response([row("known")]));vi.stubGlobal("fetch",fetch);
 await act(async()=>root.render(<CardInboxBoard/>));
 expect(fetch).toHaveBeenCalledTimes(1);
 for(let i=0;i<4;i++){await act(()=>event());await act(async()=>vi.advanceTimersByTimeAsync(100));}
 expect(fetch).toHaveBeenCalledTimes(1);
 await act(async()=>vi.advanceTimersByTimeAsync(100));expect(fetch).toHaveBeenCalledTimes(2);
 await act(()=>event());
 await act(()=>acceptV3SessionStreamEvent({type:"replay_gap",latest_id:5,instance_id:"orch"}));
 expect(fetch).toHaveBeenCalledTimes(3);
});

it("refreshes immediately after a direct card mutation",async()=>{
 const known=row("known");
 const fetch=vi.fn(async(input:RequestInfo|URL)=>{
  const url=String(input);
  if(url.includes("/status"))return new Response(JSON.stringify({card:{...known,status:"done"}}));
  if(url===`/api/cards/${known.id}`)return new Response(JSON.stringify({card:{...known,status:"done",version:2},reports:[],questions:[],sessions:[]}));
  return response([known]);
 });vi.stubGlobal("fetch",fetch);
 await act(async()=>root.render(<CardInboxBoard/>));
 await act(async()=>{await useCardStore.getState().mutate("known","/status",{status:"done"});});
 expect(fetch.mock.calls.filter(call=>String(call[0]).startsWith("/api/cards?"))).toHaveLength(2);
});

it("publishes each valid in-flight list despite continuous card events",async()=>{
 const finish:((value:Response)=>void)[]=[];
 const fetch=vi.fn(()=>new Promise<Response>(resolve=>finish.push(resolve)));vi.stubGlobal("fetch",fetch);
 await act(()=>root.render(<FolderCardSection folderId={reviewCard.folderId}/>));
 await act(async()=>vi.advanceTimersByTimeAsync(75));await act(()=>event());
 await act(async()=>vi.advanceTimersByTimeAsync(75));
 await act(async()=>finish[0](response([row("initial")])));
 expect(element.querySelector('[data-card-id="initial"]')).not.toBeNull();
 await act(async()=>vi.advanceTimersByTimeAsync(425));
 expect(fetch).toHaveBeenCalledTimes(2);
 await act(()=>event());await act(async()=>vi.advanceTimersByTimeAsync(150));
 await act(async()=>finish[1](response([row("initial"),row("incoming")])));
 expect(element.querySelector('[data-card-id="incoming"]')).not.toBeNull();
 await act(async()=>vi.advanceTimersByTimeAsync(350));
 expect(fetch).toHaveBeenCalledTimes(3);
 await act(async()=>finish[2](response([row("incoming")]))) ;
 expect(element.querySelector('[data-card-id="incoming"]')).not.toBeNull();
});

it("keeps a same-version newer detail when an older in-flight list arrives",async()=>{
 let finish!:(value:Response)=>void;
 const old={...row("known"),latestActivity:{kind:"instruction" as const,format:"markdown" as const,body:"오래된 활동",createdAt:"2026-01-01"}};
 const fresh={...old,latestActivity:{...old.latestActivity,body:"최신 활동"},attachments:[{path:"new"}]};
 vi.stubGlobal("fetch",vi.fn((input:RequestInfo|URL)=>String(input).startsWith("/api/cards?")
   ?new Promise<Response>(resolve=>{finish=resolve;})
   :Promise.resolve(new Response(JSON.stringify({card:fresh,reports:[],questions:[],sessions:[]})))));
 await act(()=>root.render(<FolderCardSection folderId={reviewCard.folderId}/>));
 await act(async()=>{await useCardStore.getState().loadCard("known");event();});
 await act(async()=>finish(response([old])));
 expect(useCardStore.getState().byId.known.latestActivity?.body).toBe("최신 활동");
 expect(useCardStore.getState().byId.known.attachments).toEqual([{path:"new"}]);
 expect(element.querySelector('[data-card-id="known"]')).not.toBeNull();
});
