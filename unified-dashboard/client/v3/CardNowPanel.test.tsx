/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { CardNow, CardNowHistoryEntry } from "@seosoyoung/soul-ui/cards/card-types";
import { CardNowPanel } from "./CardNowPanel";

const now:CardNow={text:"현재 상황",turn:"user",ask:"확인해 주세요",updatedAt:"2026-10-05T08:00:00Z",sessionId:"session"};
const history:CardNowHistoryEntry[]=[
 {text:"이전 상황",turn:"agent",ask:"진행 중",at:"2026-10-05T07:00:00Z"},
 {text:"응답 시점의 과거 값",turn:"outside",ask:null,at:"2026-10-05T07:30:00Z"},
];

describe("card now panel",()=>{
 it("renders no panel when now is missing",()=>{
  expect(renderToStaticMarkup(<CardNowPanel now={null} nowHistory={history} itemsCount={2} activeCount={1}/>)).toBe("");
 });
 it("uses now as the latest slot and hides navigation for zero or one history value",()=>{
  const html=renderToStaticMarkup(<CardNowPanel now={now} nowHistory={[history[1]]} itemsCount={2} activeCount={1}/>);
  expect(html).toContain("현재 상황");expect(html).not.toContain("응답 시점의 과거 값");
  expect(html).toContain("내 차례");expect(html).toContain("확인해 주세요");
  expect(html).not.toContain("이전 상황");expect(html).not.toContain("다음 상황");
 });
 it("shows a completed prompt without changing the stored turn",()=>{
  const html=renderToStaticMarkup(<CardNowPanel now={now} nowHistory={[]} itemsCount={2} activeCount={0}/>);
  expect(html).toContain("모두 확인했습니다. 완료로 옮길까요?");expect(html).not.toContain("확인해 주세요");
 });
 it("provides history navigation when there are at least two entries",()=>{
  const html=renderToStaticMarkup(<CardNowPanel now={now} nowHistory={history} itemsCount={2} activeCount={1}/>);
  expect(html).toContain('aria-label="이전 상황"');expect(html).toContain('aria-label="다음 상황"');
  expect(html).toContain("2/2");expect(html).toContain("현재 상황");
 });
 it("returns directly to now from an older history slot",async()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  vi.stubGlobal("ResizeObserver",class {observe(){} disconnect(){}});
  const container=document.createElement("div");document.body.append(container);
  const root=createRoot(container);
  try {
   await act(()=>root.render(<CardNowPanel now={now} nowHistory={[history[0],history[1],{...history[1],at:now.updatedAt}]} itemsCount={2} activeCount={1}/>));
   const previous=()=>container.querySelector<HTMLButtonElement>('[aria-label="이전 상황"]')!.click();
   await act(previous);await act(previous);
   expect(container.querySelector('[data-now-view="past"]')).not.toBeNull();
   await act(()=>[...container.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==="최신으로")!.click());
   expect(container.querySelector('[data-now-view="current"]')).not.toBeNull();
  } finally {await act(()=>root.unmount());container.remove();vi.unstubAllGlobals();}
 });
});
