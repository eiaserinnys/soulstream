// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CardBoard } from "./CardBoard";
import { CardBoardWorkspace } from "./CardBoardWorkspace";
import { reviewCard } from "./components-review-fixtures";
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let element:HTMLDivElement,root:Root;
beforeEach(()=>{vi.stubGlobal("ResizeObserver",class {observe(){} disconnect(){}});element=document.createElement("div");document.body.append(element);root=createRoot(element);});
afterEach(async()=>{await act(()=>root.unmount());element.remove();vi.unstubAllGlobals();});
it("keeps the board lanes and cards without stage drag handles",async()=>{
 await act(()=>root.render(<CardBoard cards={[reviewCard]} renderCard={card=><article data-card-id={card.id}>{card.title}</article>}/>));
 expect(element.querySelector('[aria-label="'+reviewCard.title+' 단계 이동"]')).toBeNull();
 expect(element.querySelector('[data-board-column="blocked"]')?.getAttribute("aria-label")).toBe("막힘");
 expect(element.querySelector('[data-card-id="'+reviewCard.id+'"]')).not.toBeNull();
});
it("expands the actual board and restores horizontal and lane scroll and focus",async()=>{
 await act(()=>root.render(<CardBoardWorkspace title="전체 카드" cards={[reviewCard]} renderCard={card=><article>{card.title}</article>}/>));
 const board=element.querySelector<HTMLElement>('.v3-card-board')!;board.scrollLeft=222;board.querySelector<HTMLElement>('.v3-card-board-lane')!.scrollTop=91;
 const expand=element.querySelector<HTMLButtonElement>('button[aria-label="보드 확대"]')!;expand.focus();await act(()=>expand.click());
 const dialog=document.querySelector('[role="dialog"][aria-label="전체 카드 보드"]')!;expect(dialog).not.toBeNull();
 expect(dialog.querySelector<HTMLElement>('.v3-card-board')!.scrollLeft).toBe(222);
 await act(()=>document.querySelector<HTMLButtonElement>('button[aria-label="확대 닫기"]')!.click());
 expect(board.scrollLeft).toBe(222);expect(board.querySelector<HTMLElement>('.v3-card-board-lane')!.scrollTop).toBe(91);expect(document.activeElement).toBe(expand);
});
