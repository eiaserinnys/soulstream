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
beforeEach(()=>{vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}});resetV3InvalidationForTest();useCardStore.getState().reset();element=document.createElement("div");document.body.append(element);root=createRoot(element);});
afterEach(async()=>{await act(()=>root.unmount());element.remove();vi.unstubAllGlobals();});
const row=(id:string)=>({...reviewCard,id,status:"todo" as const});
const response=(cards:typeof reviewCard[])=>new Response(JSON.stringify({cards}),{status:200});
const event=()=>acceptV3SessionStreamEvent({type:"card_updated",cardId:"new",folderId:reviewCard.folderId});
it("refetches authorized global membership on SSE, coalesces duplicates and removes deleted, archived and cancelled cards",async()=>{
 let rows:CardRow[]=[row("old")];const fetch=vi.fn(async()=>response(rows));vi.stubGlobal("fetch",fetch);
 useCardStore.getState().putCards([row("unlisted")]);
 await act(async()=>{root.render(<CardInboxBoard/>);});
 expect(element.querySelector('[data-card-id="old"]')).not.toBeNull();
 rows=[row("new"),row("new"),{...row("archived"),archived:true},{...row("cancelled"),status:"cancelled"}];
 await act(async()=>{event();event();});
 expect(element.querySelectorAll('[data-card-id="new"]')).toHaveLength(1);
 expect(element.querySelector('[data-card-id="old"]')).toBeNull();expect(element.querySelector('[data-card-id="unlisted"]')).toBeNull();
 expect(element.querySelector('[data-card-id="archived"]')).toBeNull();expect(element.querySelector('[data-card-id="cancelled"]')).toBeNull();
 expect(element.querySelector('.v3-folder-card-head')?.textContent).toContain("1개");expect(fetch).toHaveBeenCalledTimes(2);
});
it("does not publish a pre-event initial list or an old folder response into the new scope",async()=>{
 const resolve:((value:Response)=>void)[]=[];const fetch=vi.fn(()=>new Promise<Response>(done=>resolve.push(done)));vi.stubGlobal("fetch",fetch);
 await act(()=>root.render(<FolderCardSection folderId="first"/>));
 await act(()=>event());
 await act(async()=>resolve[0](response([{...row("stale"),folderId:"first"}])));
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
 expect(element.querySelector('[data-card-id="moving"]')).toBeNull();expect(element.querySelector('[data-card-id="incoming"][data-card-status="review"]')).not.toBeNull();
 expect(element.querySelector('[data-card-id="unlisted"]')).toBeNull();
 rows=[{...row("incoming"),status:"done",version:reviewCard.version+1}];await act(async()=>event());
 expect(element.querySelector('[data-card-id="incoming"]')).toBeNull();expect(element.querySelector('[data-board-column="done"]')).toBeNull();
});

it("keeps an open reason draft and expanded board through an SSE list refetch failure",async()=>{
 let fail=false;const card={...reviewCard,status:"review" as const};
 vi.stubGlobal("fetch",vi.fn(async(url:string)=>{if(url===`/api/cards/${card.id}`)return new Response(JSON.stringify({...reviewDetail,card}));if(fail)throw new Error("connection lost");return response([card]);}));
 await act(async()=>root.render(<CardInboxBoard/>));
 await act(()=>element.querySelector<HTMLButtonElement>('button[aria-label="보드 확대"]')!.click());
 await act(async()=>{element.querySelector<HTMLButtonElement>('button[aria-label="카드 상태 변경"]')!.click();});
 await act(()=>{[...document.querySelectorAll<HTMLButtonElement>('[data-card-status-picker] button')].find(button=>button.textContent==="실행 중")!.click();});
 const input=document.querySelector<HTMLInputElement>('input[aria-label="다시 실행할 사유"]')!;
 await act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"입력 중인 사유");input.dispatchEvent(new Event("input",{bubbles:true}));});
 fail=true;await act(async()=>event());
 expect(document.querySelector<HTMLInputElement>('input[aria-label="다시 실행할 사유"]')?.value).toBe("입력 중인 사유");
 expect(element.querySelector('[data-card-board-expanded="true"]')).not.toBeNull();
});
