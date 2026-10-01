// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CardInbox } from "./CardInbox";
import { FolderCardSection } from "./FolderCardSection";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import { reviewCard } from "./components-review-fixtures";

(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let element:HTMLDivElement,root:Root;
const original={...useCardStore.getState()};
beforeEach(()=>{useCardStore.getState().reset();element=document.createElement("div");document.body.append(element);root=createRoot(element);});
afterEach(async()=>{await act(()=>root.unmount());element.remove();useCardStore.setState(original);vi.unstubAllGlobals();});
const button=(name:string)=>element.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
const rows=[{...reviewCard,id:"draft",status:"todo" as const},{...reviewCard,id:"complete",status:"done" as const},
  {...reviewCard,id:"archived",archived:true},{...reviewCard,id:"cancelled",status:"cancelled" as const}];

it("opens the global board with its own permission-filtered list including draft and done",async()=>{
  const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({cards:rows}),{status:200}));vi.stubGlobal("fetch",fetch);
  useCardStore.getState().putCards([{...reviewCard,id:"stale-unlisted"}]);
  await act(()=>root.render(<CardInbox folders={[]}/>));expect(fetch).not.toHaveBeenCalled();
  await act(async()=>{button("보드").click();await Promise.resolve();});
  expect(fetch.mock.calls[0][0]).toBe("/api/cards");
  expect(element.querySelectorAll('[data-board-column]')).toHaveLength(6);
  expect(element.querySelector('[data-card-id="draft"]')).not.toBeNull();expect(element.querySelector('[data-card-id="complete"]')).not.toBeNull();
  expect(element.querySelector('[data-card-id="stale-unlisted"]')).toBeNull();
  expect(element.querySelector('[data-card-id="archived"]')).toBeNull();expect(element.querySelector('[data-card-id="cancelled"]')).toBeNull();
  expect(element.querySelector('[role="switch"]')).toBeNull();
});

it("shares the folder completion option between grid and board without mutating a card",async()=>{
  const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({cards:rows}),{status:200}));vi.stubGlobal("fetch",fetch);
  await act(async()=>{root.render(<FolderCardSection folderId={reviewCard.folderId}/>);await Promise.resolve();});
  expect(fetch.mock.calls[0][0]).toBe(`/api/cards?folderId=${reviewCard.folderId}`);
  expect(element.querySelector('[data-card-id="complete"]')).toBeNull();expect(element.textContent).toContain("완료 1개 숨김");
  expect(element.querySelectorAll('[data-board-column]')).toHaveLength(6);
  const show=[...element.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==="완료 포함 켜기")!;
  await act(()=>show.click());expect(element.querySelector('[data-card-id="complete"]')).not.toBeNull();
  await act(()=>button("일반 보기").click());expect(element.querySelector('[data-card-id="complete"]')).not.toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("starts the card home directly in the permission-filtered six-lane board",async()=>{
 const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({cards:rows}),{status:200}));vi.stubGlobal("fetch",fetch);
 await act(async()=>{root.render(<CardInbox folders={[]} initialBoard/>);await Promise.resolve();});
 expect(element.querySelectorAll('[data-board-column]')).toHaveLength(6);
 expect(element.querySelector('[data-card-id="complete"]')).not.toBeNull();
 expect(element.querySelector('button[aria-label="보드 확대"]')).not.toBeNull();
 expect(element.querySelector('[data-board-column="todo"] button[aria-label="새 카드"]')).not.toBeNull();
});
