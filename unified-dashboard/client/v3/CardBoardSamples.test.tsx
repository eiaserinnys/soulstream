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

it("shows the awaiting verification sample beside running with the server-style now text",async()=>{
 await act(()=>root.render(<QueryClientProvider client={queryClient}><CardBoardSamples/></QueryClientProvider>));
 const awaiting=element.querySelector<HTMLElement>('[data-board-column="awaiting_verification"] [data-card-id="board-3-0"]');
 expect(awaiting).not.toBeNull();
 expect(awaiting?.getAttribute("data-card-status")).toBe("awaiting_verification");
 expect(awaiting?.querySelector('[data-slot="status-chip"]')?.getAttribute("aria-label")).toBe("검증 대기");
 expect(awaiting?.querySelector("[data-card-now]")?.textContent).toContain("배포 뒤 실제 사용 확인, 14:30에 다시 확인");
});

it("retains a mixed sample card after its status moves outside the initial seed set",async()=>{
 await act(()=>root.render(<QueryClientProvider client={queryClient}><CardBoardSamples/></QueryClientProvider>));
 expect(element.querySelector('[data-board-column="on_hold"] [data-card-id="board-6-0"]')).not.toBeNull();
 const card=element.querySelector<HTMLElement>('[data-card-id="board-0-0"]')!;
 expect(card).not.toBeNull();
 await act(async()=>{card.querySelector<HTMLButtonElement>('[aria-label="카드 상태 변경"]')!.click();await new Promise(resolve=>setTimeout(resolve,0));});
 const queueOption=[...document.querySelectorAll<HTMLButtonElement>('[data-card-status-picker] button')].find(button=>button.textContent==="대기");
 expect(queueOption).toBeDefined();
 await act(async()=>{queueOption!.click();await Promise.resolve();});
 expect(element.querySelector('[data-card-id="board-0-0"]')?.getAttribute("data-card-status")).toBe("queued");
 expect(element.querySelector('[data-board-column="queued"] [data-card-id="board-0-0"]')).not.toBeNull();
});
