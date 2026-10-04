// @vitest-environment jsdom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {CardBoardSamples} from "./CardBoardSamples";

(globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let element:HTMLDivElement,root:Root,queryClient:QueryClient;
beforeEach(()=>{
 vi.stubGlobal("PointerEvent",MouseEvent);
 vi.stubGlobal("ResizeObserver",class {observe(){}unobserve(){}disconnect(){}});
 vi.stubGlobal("matchMedia",(media:string)=>({matches:false,media,onchange:null,addListener:vi.fn(),removeListener:vi.fn(),addEventListener:vi.fn(),removeEventListener:vi.fn(),dispatchEvent:vi.fn()}));
 element=document.createElement("div");document.body.append(element);root=createRoot(element);queryClient=new QueryClient({defaultOptions:{queries:{retry:false}}});
});
afterEach(async()=>{await act(()=>root.unmount());queryClient.clear();element.remove();vi.unstubAllGlobals();});

it("retains a mixed sample card after its status moves outside the initial seed set",async()=>{
 await act(()=>root.render(<QueryClientProvider client={queryClient}><CardBoardSamples/></QueryClientProvider>));
 const card=element.querySelector<HTMLElement>('[data-card-id="board-0-0"]')!;
 expect(card).not.toBeNull();
 await act(async()=>{card.querySelector<HTMLButtonElement>('[aria-label="카드 상태 변경"]')!.click();await new Promise(resolve=>setTimeout(resolve,0));});
 const queueOption=[...document.querySelectorAll<HTMLButtonElement>('[data-card-status-picker] button')].find(button=>button.textContent==="대기");
 expect(queueOption).toBeDefined();
 await act(async()=>{queueOption!.click();await Promise.resolve();});
 expect(element.querySelector('[data-card-id="board-0-0"]')?.getAttribute("data-card-status")).toBe("queued");
 expect(element.querySelector('[data-board-column="queued"] [data-card-id="board-0-0"]')).not.toBeNull();
});
