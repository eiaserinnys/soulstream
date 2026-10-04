/** @vitest-environment jsdom */
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {CardApiError} from "@seosoyoung/soul-ui/cards/card-api";
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

it("locks an uncertain submission and replays the same snapshot after a lost response or 409", async () => {
 let reject!:(error:Error)=>void;
 const onSave=vi.fn().mockImplementationOnce(()=>new Promise((_,r)=>{reject=r;}))
  .mockRejectedValueOnce(new CardApiError('409 충돌',409)).mockResolvedValue({id:'created'});
 const {title,save,setTitle,onClose,onCreated,upload}=await mountCard(onSave);
 await setTitle('첫 카드');
 await act(async()=>{save.click();save.click();await Promise.resolve();});
 expect(onSave).toHaveBeenCalledTimes(1);
 await act(()=>{document.querySelector<HTMLButtonElement>('[aria-label="새 카드 닫기"]')!.click();});
 expect(onClose).not.toHaveBeenCalled();
 await act(async()=>{reject(new Error('응답 손실'));await Promise.resolve();});
 expect(title.disabled).toBe(true);
 expect(document.querySelector<HTMLTextAreaElement>('[aria-label="요청 원문"]')!.disabled).toBe(true);
 expect(document.querySelector<HTMLSelectElement>('[aria-label="노드 선택"]')!.disabled).toBe(true);
 expect(document.querySelector<HTMLButtonElement>('[aria-label="폴더 선택"]')!.disabled).toBe(true);
 expect(document.querySelector<HTMLInputElement>('input[type="file"]')!.matches(':disabled')).toBe(true);
 expect(document.querySelector<HTMLButtonElement>('[aria-label="Remove file"]')!.matches(':disabled')).toBe(true);
 expect(save.textContent).toBe('같은 제출로 다시 확인');
 expect(document.body.textContent).toContain('이미 저장되었을 수 있습니다');
 await setTitle('바꾸려는 제목');
 expect(title.value).toBe('첫 카드');
 await act(()=>document.querySelector<HTMLButtonElement>('[aria-label="Remove file"]')!.click());
 expect(upload.removeFile).not.toHaveBeenCalled();expect(upload.resetLocal).not.toHaveBeenCalled();
 await act(async()=>{save.click();await Promise.resolve();});
 expect(onSave.mock.calls[1][0]).toBe(onSave.mock.calls[0][0]);
 expect(title.disabled).toBe(true);
 await act(async()=>{save.click();save.click();await Promise.resolve();});
 expect(onSave.mock.calls[2][0]).toBe(onSave.mock.calls[0][0]);
 expect(onSave.mock.calls[2][0]).toMatchObject({title:'첫 카드',attachments:[{path:'/uploaded'}]});
 expect(onCreated).toHaveBeenCalledTimes(1);expect(onClose).toHaveBeenCalledTimes(1);expect(upload.resetLocal).toHaveBeenCalledTimes(1);
});

it("unlocks a definitively rejected card so corrected input gets a new key", async () => {
 const onSave=vi.fn().mockRejectedValueOnce(new CardApiError('요청을 수정하세요',422)).mockResolvedValue({id:'created'});
 const {title,save,setTitle,upload}=await mountCard(onSave);
 await setTitle('첫 카드');await act(async()=>{save.click();await Promise.resolve();});
 expect(title.disabled).toBe(false);expect(upload.resetLocal).not.toHaveBeenCalled();
 expect(document.body.textContent).not.toContain('이미 저장되었을 수 있습니다');
 await setTitle('수정 카드');await act(async()=>{save.click();await Promise.resolve();});
 expect(onSave.mock.calls[1][0].idempotencyKey).not.toBe(onSave.mock.calls[0][0].idempotencyKey);
 expect(onSave.mock.calls[1][0]).toMatchObject({title:'수정 카드',attachments:[{path:'/uploaded'}]});
});

async function mountCard(onSave: ReturnType<typeof vi.fn>) {
 const {CardCreateDialog}=await import('./CardCreateDialog');
 const {dialoguesAssignment}=await import('./dialogues-api');
 const onClose=vi.fn(),onCreated=vi.fn();
 const upload={files:[{id:'file',file:new File(['내용'],'자료.txt'),path:'/uploaded',status:'success'}],isReady:true,isUploading:false,addFiles:vi.fn(),removeFile:vi.fn(),cancel:vi.fn(),resetLocal:vi.fn(),uploadedPaths:['/uploaded']} as any;
 await act(()=>root.render(<QueryClientProvider client={new QueryClient()}><CardCreateDialog folders={[{id:'f',name:'폴더'} as any]} initialFolderId="f" assignment={dialoguesAssignment} uploadController={upload} onSave={onSave} onClose={onClose} onCreated={onCreated}/></QueryClientProvider>));
 const title=document.querySelector<HTMLInputElement>('[aria-label="카드 제목"]')!;
 const setTitle=async(value:string)=>act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(title,value);title.dispatchEvent(new Event('input',{bubbles:true}));});
 const save=document.querySelector<HTMLButtonElement>('[aria-label="카드 저장"]')!;
 return {title,save,setTitle,onClose,onCreated,upload};
}

it('keeps completed execution settings on save failure and starts only after atomic save',async()=>{
 const {CardExecutionSettingsDialog}=await import('./CardExecutionSettings');
 const {dialoguesAssignment}=await import('./dialogues-api');
 const {reviewCard}=await import('./components-review-fixtures');
 const card={...reviewCard,assigneeSessionId:null,folderId:'f',nodeId:'sample-node',assigneeAgentId:'roselin',modelPreset:null};
 const saved={...card,modelPreset:'sample-sol',version:card.version+1};
 const save=vi.fn().mockRejectedValueOnce(new CardApiError('저장 실패',422)).mockResolvedValue(saved),start=vi.fn(),close=vi.fn();
 await act(()=>root.render(<QueryClientProvider client={new QueryClient()}><CardExecutionSettingsDialog card={card} folders={[{id:'f',name:'폴더'} as any]} assignment={dialoguesAssignment} startAfterSave onSave={save} onStart={start} onClose={close}/></QueryClientProvider>));
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,30));});
 const button=document.querySelector<HTMLButtonElement>('[aria-label="카드 설정 저장"]')!;
 expect(button.disabled).toBe(false);
 await act(async()=>{button.click();await Promise.resolve();});
 expect(start).not.toHaveBeenCalled();expect(close).not.toHaveBeenCalled();
 expect(document.body.textContent).toContain('카드를 저장하지 못했습니다.');
 await act(async()=>{button.click();await Promise.resolve();});
 expect(save.mock.calls[1][0]).toEqual(save.mock.calls[0][0]);
 expect(start).toHaveBeenCalledWith(saved);expect(close).toHaveBeenCalledTimes(1);
});
