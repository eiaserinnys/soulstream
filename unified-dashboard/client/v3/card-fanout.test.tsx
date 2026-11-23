// @vitest-environment jsdom
import { act, Profiler } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { dispatchSessionStreamEvent } from "../../../packages/soul-ui/src/hooks/session-stream-dispatch";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import type { CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { PostItCard } from "./PostItCard";
import { reviewCard } from "./components-review-fixtures";
import { useCardMembership } from "./use-card-membership";
import { useCompletedCards } from "./use-completed-cards";
import { acceptV3SessionStreamEvent, resetV3InvalidationForTest } from "./v3-live-invalidation-plane";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("measures spaced create, move and completion events through stream dispatch", async () => {
  vi.stubGlobal("matchMedia",(query:string)=>({matches:false,media:query,addListener:vi.fn(),removeListener:vi.fn(),addEventListener:vi.fn(),removeEventListener:vi.fn()}));
  resetV3InvalidationForTest();
  useCardStore.getState().reset();
  const base = (id:string):CardRow => ({...reviewCard,id,title:id,folderId:"folder",status:"running"});
  let rows = [base("one"),base("two")];
  let list = 0, detail = 0, renders = 0;
  const fetch = vi.fn(async (input:RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/cards?")) {
      list++;
      const done = url.includes("status=done");
      return new Response(JSON.stringify({cards:rows.filter(card=>done ? card.status==="done" : card.status!=="done"),nextCursor:null}));
    }
    detail++;
    const id = url.split("/").at(-1);
    return new Response(JSON.stringify({card:rows.find(card=>card.id===id),reports:[],questions:[],sessions:[]}));
  });
  vi.stubGlobal("fetch",fetch);
  const host=document.createElement("div"),root=createRoot(host);
  function Board() {
    const {cards}=useCardMembership();
    const done=useCompletedCards(undefined,true);
    return <><div data-done>{done.cards.map(card=><Profiler key={card.id} id={`done-${card.id}`} onRender={()=>{renders++;}}><PostItCard card={card}/></Profiler>)}</div>{cards.map(card=><Profiler key={card.id} id={card.id} onRender={()=>{renders++;}}><PostItCard card={card}/></Profiler>)}</>;
  }
  try {
    await act(async()=>root.render(<Board/>));
    list=0;detail=0;renders=0;
    const emit=async (id:string)=>act(async()=>dispatchSessionStreamEvent({type:"card_updated",cardId:id,folderId:"folder"},{
      onCardUpdated:event=>{void useCardStore.getState().handleCardUpdated(event);},onEvent:acceptV3SessionStreamEvent,
    }));
    rows=[...rows,base("new")];await emit("new");
    await act(async()=>new Promise(resolve=>setTimeout(resolve,100)));
    rows=rows.map(card=>card.id==="one"?{...card,folderId:"other",version:2}:card);await emit("one");
    await act(async()=>new Promise(resolve=>setTimeout(resolve,100)));
    const lastEventAt=performance.now();
    rows=rows.map(card=>card.id==="two"?{...card,status:"done",version:2}:card);await emit("two");
    const doneDisplayed=()=>Boolean(host.querySelector('[data-done] [data-card-id="two"][data-card-status="done"]'));
    let displayedAt:number|null=doneDisplayed()?Math.round(performance.now()-lastEventAt):null;
    for(let elapsed=25;elapsed<=600;elapsed+=25){
      await act(async()=>new Promise(resolve=>setTimeout(resolve,25)));
      if(displayedAt===null&&doneDisplayed())displayedAt=Math.round(performance.now()-lastEventAt);
    }
    console.log(`fanout measurement: lists=${list} details=${detail} postit_commits=${renders} final_delay_ms=${displayedAt}`);
    expect(doneDisplayed()).toBe(true);
    expect(list).toBeLessThanOrEqual(4);
    expect(detail).toBeLessThanOrEqual(2);
  } finally {
    await act(()=>root.unmount());
    vi.unstubAllGlobals();useCardStore.getState().reset();
  }
});
