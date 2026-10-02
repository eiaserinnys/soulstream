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
beforeEach(()=>{vi.stubGlobal("PointerEvent",MouseEvent);vi.stubGlobal("ResizeObserver",class {observe(){} unobserve(){} disconnect(){}});useCardStore.getState().reset();element=document.createElement("div");document.body.append(element);root=createRoot(element);});
afterEach(async()=>{await act(()=>root.unmount());element.remove();useCardStore.setState(original);vi.unstubAllGlobals();});
const button=(name:string)=>element.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
const rows=[{...reviewCard,id:"draft",status:"todo" as const},{...reviewCard,id:"complete",status:"done" as const},
  {...reviewCard,id:"archived",archived:true},{...reviewCard,id:"cancelled",status:"cancelled" as const}];

it("opens the global board with its own permission-filtered list including draft and done",async()=>{
  const fetch=vi.fn(async(url:string)=>new Response(JSON.stringify(url.includes("status=done")?{cards:rows.filter(c=>c.status==="done"),nextCursor:null}:{cards:rows.filter(c=>c.status!=="done")}),{status:200}));vi.stubGlobal("fetch",fetch);
  useCardStore.getState().putCards([{...reviewCard,id:"stale-unlisted"}]);
  await act(()=>root.render(<CardInbox folders={[]}/>));expect(fetch).not.toHaveBeenCalled();
  await act(async()=>{button("보드").click();await Promise.resolve();});
  expect(fetch.mock.calls[0][0]).toBe("/api/cards?includeCompleted=false");
  expect(element.querySelectorAll('[data-board-column]')).toHaveLength(5);
  expect(element.querySelector('[data-card-id="draft"]')).not.toBeNull();expect(element.querySelector('[data-board-column="done"]')).toBeNull();
  expect(element.querySelector('[data-card-id="stale-unlisted"]')).toBeNull();
  expect(element.querySelector('[data-card-id="archived"]')).toBeNull();expect(element.querySelector('[data-card-id="cancelled"]')).toBeNull();
  expect(element.querySelector('[role="switch"]')).not.toBeNull();
});

it("shares the folder completion option between grid and board without mutating a card",async()=>{
  const fetch=vi.fn(async(url:string)=>new Response(JSON.stringify(url.includes("status=done")?{cards:rows.filter(c=>c.status==="done"),nextCursor:null}:{cards:rows.filter(c=>c.status!=="done")}),{status:200}));vi.stubGlobal("fetch",fetch);
  await act(async()=>{root.render(<FolderCardSection folderId={reviewCard.folderId}/>);await Promise.resolve();});
  expect(fetch.mock.calls[0][0]).toBe(`/api/cards?includeCompleted=false&folderId=${reviewCard.folderId}`);
  expect(element.querySelector('[data-card-id="complete"]')).toBeNull();
  expect(element.querySelectorAll('[data-board-column]')).toHaveLength(5);
  const show=element.querySelector<HTMLButtonElement>('[role="switch"]')!;
  await act(async()=>{show.click();await Promise.resolve();});expect(element.querySelector('[data-board-column="done"]')).not.toBeNull();
  await act(()=>button("일반 보기").click());expect(element.querySelector('[data-testid="completed-viewport"]')).not.toBeNull();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("starts the card home directly in the permission-filtered six-lane board",async()=>{
 const fetch=vi.fn(async(url:string)=>new Response(JSON.stringify(url.includes("status=done")?{cards:rows.filter(c=>c.status==="done"),nextCursor:null}:{cards:rows.filter(c=>c.status!=="done")}),{status:200}));vi.stubGlobal("fetch",fetch);
 await act(async()=>{root.render(<CardInbox folders={[]} initialBoard/>);await Promise.resolve();});
 expect(element.querySelectorAll('[data-board-column]')).toHaveLength(5);
 expect(element.querySelector('[data-board-column="done"]')).toBeNull();
 expect(element.querySelector('button[aria-label="보드 확대"]')).not.toBeNull();
 expect(element.querySelector('[data-board-column="todo"] button[aria-label="새 카드"]')).not.toBeNull();
});
