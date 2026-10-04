// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import { useCardNavigation } from "./card-navigation";
import { useDashboardStore } from "@seosoyoung/soul-ui";
import { PostItCard } from "./PostItCard";
import { reviewCard, reviewDetail } from "./components-review-fixtures";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT:boolean }).IS_REACT_ACT_ENVIRONMENT=true;
let element:HTMLDivElement,root:Root;
const original = { ...useCardStore.getState() };
const originalOpen = useCardNavigation.getState().open;
const originalClipboard=Object.getOwnPropertyDescriptor(navigator,"clipboard");
beforeEach(() => {
  vi.stubGlobal("matchMedia",()=>({matches:false,addEventListener:vi.fn(),removeEventListener:vi.fn()}));
  element=document.createElement("div");document.body.append(element);root=createRoot(element);
});
afterEach(async () => {
  await act(()=>root.unmount());element.remove();useCardStore.setState(original);useCardNavigation.setState({open:originalOpen});
  if(originalClipboard)Object.defineProperty(navigator,"clipboard",originalClipboard);else Reflect.deleteProperty(navigator,"clipboard");
  vi.unstubAllGlobals();
});

it("opens the whole card and never fetches per-card detail on list mount", async () => {
  const open=vi.fn(),loadCard=vi.fn();
  useCardStore.setState({loadCard});useCardNavigation.setState({open});
  await act(()=>root.render(<PostItCard card={{...reviewCard,latestActivity:{kind:"report",format:"html",body:"<p>운영 본문</p>",createdAt:reviewCard.createdAt}}}/>));
  expect(loadCard).not.toHaveBeenCalled();expect(element.textContent).toContain("운영 본문");
  await act(()=>element.querySelector<HTMLButtonElement>(".v3-postit-open")!.click());
  expect(open).toHaveBeenCalledWith(reviewCard.id,"overlay");
});

it("opens the ordered card context menu and routes a selected status through the existing mutation", async () => {
  const writeText=vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText}});
  const mutate=vi.fn().mockResolvedValue({});
  useCardStore.setState({mutate,loadCard:vi.fn().mockResolvedValue({...reviewDetail,card:{...reviewCard,status:"review"},questions:[]})});
  await act(()=>root.render(<PostItCard card={{...reviewCard,status:"review"}}/>));
  const card=element.querySelector<HTMLElement>('.v3-postit-card')!;
  await act(()=>card.dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:40,clientY:30})));
  const menu=document.querySelector<HTMLElement>('[data-slot="menu-popup"]')!;
  expect(menu.textContent).toContain("카드 ID 복사");
  expect(menu.textContent).not.toContain(reviewCard.id);
  expect(menu.textContent).toContain("카드 상태 변경");
  expect([...menu.querySelectorAll<HTMLElement>('[data-slot="menu-item"]')].map(item=>item.textContent?.trim())).toEqual([
    "카드 ID 복사","드래프트","대기","실행 중","막힘","검수 대기","완료","취소",
  ]);
  await act(async()=>{menu.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click();await Promise.resolve();});
  expect(writeText).toHaveBeenCalledWith(reviewCard.id);
  await act(()=>card.dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:40,clientY:30})));
  const reopened=document.querySelector<HTMLElement>('[data-slot="menu-popup"]')!;
  const queued=[...reopened.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item=>item.textContent?.trim()==="대기")!;
  await act(async()=>{queued.click();await Promise.resolve();await Promise.resolve();});
  expect(mutate).toHaveBeenCalledWith(reviewCard.id,"/status",{status:"queued",expectedVersion:reviewCard.version});
});

it("opens the dedicated menu with the keyboard context-menu command",async()=>{
 await act(()=>root.render(<PostItCard card={reviewCard}/>));
 const open=element.querySelector<HTMLButtonElement>(".v3-postit-open")!;
 await act(()=>open.dispatchEvent(new KeyboardEvent("keydown",{bubbles:true,cancelable:true,key:"F10",shiftKey:true})));
 expect(document.querySelector('[data-slot="menu-popup"]')?.textContent).toContain("카드 상태 변경");
});

it.each([14,17,18] as const)("updates card and grid proportions from chat preference %i", async fontSize => {
  await act(()=>useDashboardStore.setState({chatFontSize:fontSize}));
  await act(()=>root.render(<PostItCard card={reviewCard}/>));
  const card=element.querySelector<HTMLElement>(".v3-postit-card")!;
  expect(card.style.getPropertyValue("--postit-scale")).toBe(String(fontSize/17));
  expect(card.style.getPropertyValue("--postit-font-size")).toBe(`${fontSize}px`);
  await act(()=>useDashboardStore.setState({chatFontSize:14}));
});
