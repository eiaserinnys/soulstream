/** @vitest-environment jsdom */
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {CardInbox} from "./CardInbox";
import {useCardStore} from "@seosoyoung/soul-ui/cards/card-store";
import {useOrchestratorStore} from "../store/orchestrator-store";
let root:Root,container:HTMLDivElement;
beforeEach(()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 container=document.createElement("div");document.body.append(container);root=createRoot(container);
 useCardStore.getState().reset();
 useOrchestratorStore.setState({nodes:new Map([["node",{nodeId:"node",status:"connected"} as any]])});
 vi.stubGlobal("fetch",vi.fn(async(input:unknown)=>({ok:true,json:async()=>String(input).startsWith("/api/cards")?{cards:[]}:String(input).includes("model-presets")?{model_presets:[{id:"sol",label:"Sol",backend:"codex",available:true}]}:{agents:[{id:"roselin",name:"로젤린",default_preset:"sol"}]}})));
});
afterEach(async()=>{await act(()=>root.unmount());container.remove();vi.unstubAllGlobals();});
it("opens the complete card dialog from the general list",async()=>{
 const initialBoard=false;
 await act(()=>root.render(<QueryClientProvider client={new QueryClient()}><CardInbox folders={[{id:"f",name:"폴더"} as any]} initialBoard={initialBoard}/></QueryClientProvider>));
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,25));});
 await act(()=>{(container.querySelector(`[aria-label="${initialBoard?'새 카드':'카드 추가'}"]`) as HTMLButtonElement).click();});
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,25));});
 const dialog=document.querySelector('[role="dialog"]')!;
 expect(dialog).not.toBeNull();
 expect(dialog.querySelector('[data-slot="dialog-title"]')?.textContent).toBe("새 카드");
 for(const label of ["카드 제목","요청 원문","노드 선택","에이전트 선택","모델 선택"])
  expect(dialog.querySelector(`[aria-label="${label}"]`),label).not.toBeNull();
 expect(dialog.querySelector('input[type="file"]')).not.toBeNull();
 expect(dialog.querySelector('[data-slot="dialog-header"]')).not.toBeNull();
 expect(dialog.querySelector('[data-slot="dialog-footer"]')).not.toBeNull();
});
