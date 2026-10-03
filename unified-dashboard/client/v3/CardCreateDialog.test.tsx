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
 expect(dialog.querySelector('[aria-label="카드 저장"]')?.textContent).toBe("드래프트 저장");
 expect(dialog.textContent).toContain("저장해도 바로 실행되지 않습니다");
 const request=dialog.querySelector('[aria-label="요청 원문"]')!, execution=dialog.querySelector('details')!;
 expect(request.compareDocumentPosition(execution) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 expect(dialog.querySelector('input[type="file"]')!.compareDocumentPosition(execution) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("submits once, preserves failed payload/key and attachments, and uses a new key after edits", async () => {
 const {CardCreateDialog}=await import('./CardCreateDialog');
 const {dialoguesAssignment}=await import('./dialogues-api');
 const onClose=vi.fn(),onCreated=vi.fn(),resetLocal=vi.fn();
 let reject!:(error:Error)=>void;
 const onSave=vi.fn().mockImplementationOnce(()=>new Promise((_,r)=>{reject=r;})).mockRejectedValueOnce(new Error('409 충돌')).mockResolvedValue({id:'created'});
 const upload={files:[{id:'file',file:new File(['내용'],'자료.txt'),path:'/uploaded',status:'success'}],isReady:true,isUploading:false,addFiles:vi.fn(),removeFile:vi.fn(),cancel:vi.fn(),resetLocal,uploadedPaths:['/uploaded']} as any;
 await act(()=>root.render(<QueryClientProvider client={new QueryClient()}><CardCreateDialog folders={[{id:'f',name:'폴더'} as any]} initialFolderId="f" assignment={dialoguesAssignment} uploadController={upload} onSave={onSave} onClose={onClose} onCreated={onCreated}/></QueryClientProvider>));
 const title=document.querySelector<HTMLInputElement>('[aria-label="카드 제목"]')!;
 const setTitle=async(value:string)=>act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(title,value);title.dispatchEvent(new Event('input',{bubbles:true}));});
 await setTitle('첫 카드');
 const save=document.querySelector<HTMLButtonElement>('[aria-label="카드 저장"]')!;
 expect(save.disabled).toBe(false);
 await act(()=>{save.click();save.click();});
 expect(onSave).toHaveBeenCalledTimes(1);
 await act(()=>{document.querySelector<HTMLButtonElement>('[aria-label="새 카드 닫기"]')!.click();});
 expect(onClose).not.toHaveBeenCalled();
 await act(()=>reject(new Error('응답 손실')));
 expect(title.value).toBe('첫 카드');expect(resetLocal).not.toHaveBeenCalled();
 await act(()=>save.click());
 expect(onSave.mock.calls[1][0]).toBe(onSave.mock.calls[0][0]);
 await setTitle('수정 카드');
 await act(()=>{save.click();save.click();});
 expect(onSave.mock.calls[2][0].idempotencyKey).not.toBe(onSave.mock.calls[0][0].idempotencyKey);
 expect(onSave.mock.calls[2][0].attachments).toHaveLength(1);
 expect(onCreated).toHaveBeenCalledTimes(1);expect(onClose).toHaveBeenCalledTimes(1);expect(resetLocal).toHaveBeenCalledTimes(1);
});
