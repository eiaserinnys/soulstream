// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CardBoard } from "./CardBoard";
import { CardBoardWorkspace } from "./CardBoardWorkspace";
import { reviewCard } from "./components-review-fixtures";
import type { CompletedBrowser } from "./use-completed-cards";
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let element:HTMLDivElement,root:Root;
beforeEach(()=>{vi.stubGlobal("ResizeObserver",class {observe(){} disconnect(){}});element=document.createElement("div");document.body.append(element);root=createRoot(element);});
afterEach(async()=>{await act(()=>root.unmount());element.remove();vi.unstubAllGlobals();});
function makeCompletedBrowser(overrides:Partial<CompletedBrowser>={}):CompletedBrowser {
 return {cards:[],loading:false,error:"완료 카드 검색 실패",resetKey:"completed-search",period:"7",setPeriod:vi.fn(),start:"",setStart:vi.fn(),end:"",setEnd:vi.fn(),search:"",setSearch:vi.fn(),loadMore:vi.fn(),retry:vi.fn(),hasMore:false,...overrides};
}
it("keeps the board lanes and cards without stage drag handles",async()=>{
 await act(()=>root.render(<CardBoard cards={[reviewCard]} renderCard={card=><article data-card-id={card.id}>{card.title}</article>}/>));
 expect(element.querySelector('[aria-label="'+reviewCard.title+' 단계 이동"]')).toBeNull();
 expect(element.querySelector('[data-board-column="blocked"]')?.getAttribute("aria-label")).toBe("막힘");
 expect(element.querySelector('[data-card-id="'+reviewCard.id+'"]')).not.toBeNull();
});
it("expands the actual board and restores horizontal and lane scroll and focus",async()=>{
 await act(()=>root.render(<CardBoardWorkspace title="전체 카드" cards={[reviewCard]} renderCard={card=><article>{card.title}</article>}/>));
 const board=element.querySelector<HTMLElement>('.v3-card-board')!;
 Object.defineProperty(board,"clientWidth",{configurable:true,value:400});Object.defineProperty(board,"scrollWidth",{configurable:true,value:2000});
 board.getBoundingClientRect=()=>({left:100,right:500,top:0,bottom:400,width:400,height:400,x:100,y:0,toJSON:()=>({})});
 board.querySelectorAll<HTMLElement>("[data-board-column]").forEach(column=>{column.getBoundingClientRect=()=>{
   const index=[...board.querySelectorAll("[data-board-column]")].indexOf(column),left=100+index*140-board.scrollLeft;
   return {left,right:left+120,top:0,bottom:400,width:120,height:400,x:left,y:0,toJSON:()=>({})};
 };});
 board.scrollLeft=222;board.querySelector<HTMLElement>('[data-board-column="running"] .v3-card-board-lane')!.scrollTop=91;
 const expand=element.querySelector<HTMLButtonElement>('button[aria-label="보드 확대"]')!;expand.focus();await act(()=>expand.click());
 const dialog=document.querySelector('[role="dialog"][aria-label="전체 카드 보드"]')!;expect(dialog).not.toBeNull();
 const expandedBoard=dialog.querySelector<HTMLElement>('.v3-card-board')!;
 const expandedRunning=dialog.querySelector<HTMLElement>('[data-board-column="running"]')!;
 expect(100-expandedRunning.getBoundingClientRect().left).toBe(222);
 expect(dialog.querySelector<HTMLElement>('[data-board-column="running"] .v3-card-board-lane')!.scrollTop).toBe(91);
 dialog.querySelector<HTMLElement>('[data-board-column="todo"] .v3-card-board-lane')!.scrollTop=41;
 expandedBoard.scrollLeft=500;
 await act(()=>document.querySelector<HTMLButtonElement>('button[aria-label="확대 닫기"]')!.click());
 expect(board.scrollLeft).toBe(222);expect(board.querySelector<HTMLElement>('[data-board-column="running"] .v3-card-board-lane')!.scrollTop).toBe(91);expect(document.activeElement).toBe(expand);
});

it("keeps completed search and feedback above the main board when its actual result is empty",async()=>{
 const staleDone={...reviewCard,id:"stale-completed",status:"done" as const};
 const completed=makeCompletedBrowser();
 await act(()=>root.render(<CardBoardWorkspace title="전체 카드" cards={[staleDone]} completed={completed} completion={{includeCompleted:true,onChange:vi.fn()}} renderCard={card=><article>{card.title}</article>}/>));
 expect(element.querySelector('[data-board-column="done"]')).toBeNull();
 const controls=element.querySelector<HTMLElement>(".v3-completed-controls")!;
 const board=element.querySelector<HTMLElement>(".v3-card-board")!;
 expect(controls).not.toBeNull();
 expect(controls.compareDocumentPosition(board)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 expect(controls.querySelector('[aria-label="제목 또는 요청 검색"]')).not.toBeNull();
 expect(element.querySelector('[role="alert"]')?.textContent).toContain("완료 카드 검색 실패");
 expect([...element.querySelectorAll("button")].some(button=>button.textContent==="다시 불러오기")).toBe(true);
 expect(element.querySelector('[role="status"]')?.textContent).toBe("선택한 기간에 완료 카드가 없습니다");

 await act(()=>element.querySelector<HTMLButtonElement>('button[aria-label="보드 확대"]')!.click());
 const doneLane=document.querySelector<HTMLElement>('[role="dialog"] [data-board-column="done"]')!;
 expect(doneLane).not.toBeNull();
 expect(doneLane.querySelector(".v3-completed-controls")).not.toBeNull();
 expect(doneLane.querySelector('[data-testid="completed-viewport"]')).not.toBeNull();
 expect(document.querySelectorAll(".v3-completed-controls")).toHaveLength(1);
 expect(doneLane.querySelector('[role="alert"]')?.textContent).toContain("완료 카드 검색 실패");
 await act(()=>document.querySelector<HTMLButtonElement>('button[aria-label="확대 닫기"]')!.click());
 await act(()=>root.render(<CardBoardWorkspace title="전체 카드" cards={[staleDone]} completed={completed} completion={{includeCompleted:false,onChange:vi.fn()}} renderCard={card=><article>{card.title}</article>}/>));
 expect(element.querySelector(".v3-completed-controls")).toBeNull();
 expect(element.querySelector('[data-board-column="done"]')).toBeNull();
});
