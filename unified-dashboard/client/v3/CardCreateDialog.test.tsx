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
 for(const label of ["카드 제목","요청 원문","노드 선택","에이전트 선택","모델"])
  expect(dialog.querySelector(`[aria-label="${label}"]`),label).not.toBeNull();
 expect(dialog.querySelector('[data-slot="select-trigger"][aria-label="모델"]')).not.toBeNull();
 expect(dialog.querySelector('input[type="file"]')).not.toBeNull();
 expect(dialog.querySelector('[data-slot="dialog-header"]')).not.toBeNull();
 expect(dialog.querySelector('[data-slot="dialog-footer"]')).not.toBeNull();
 expect(dialog.querySelector('[aria-label="카드 저장"]')?.textContent).toBe("드래프트 저장");
 expect(dialog.textContent).toContain("드래프트로 저장한 뒤 카드에서 시작할 수 있습니다.");
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
 expect(document.querySelector<HTMLButtonElement>('[aria-label="노드 선택"]')!.disabled).toBe(true);
 expect(document.querySelector<HTMLButtonElement>('[aria-label="폴더 선택"]')!.disabled).toBe(true);
 expect(document.querySelector<HTMLInputElement>('input[type="file"]')!.matches(':disabled')).toBe(true);
 expect(document.querySelector<HTMLButtonElement>('[aria-label="첨부 제거"]')!.matches(':disabled')).toBe(true);
 expect(save.textContent).toBe('같은 제출로 다시 확인');
 expect(document.body.textContent).toContain('이미 저장되었을 수 있습니다');
 await setTitle('바꾸려는 제목');
 expect(title.value).toBe('첫 카드');
 await act(()=>document.querySelector<HTMLButtonElement>('[aria-label="첨부 제거"]')!.click());
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
 const node=document.querySelector<HTMLButtonElement>('[aria-label="노드 선택"]')!;
 await act(async()=>{node.click();await new Promise(resolve=>setTimeout(resolve,30));});
 await vi.waitFor(()=>expect([...document.querySelectorAll<HTMLElement>('[data-slot="select-item"]')].some(item=>item.textContent?.trim()==='sample-node')).toBe(true));
 const item=[...document.querySelectorAll<HTMLElement>('[data-slot="select-item"]')].find(option=>option.textContent?.trim()==='sample-node')!;
 await act(()=>item.dispatchEvent(new MouseEvent('mousemove',{bubbles:true})));
 await act(()=>item.click());
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

it('refreshes the destination list immediately when execution settings move a card',async()=>{
 const {CardExecutionSettingsDialog}=await import('./CardExecutionSettings');
 const {useCardMembership}=await import('./use-card-membership');
 const {dialoguesAssignment}=await import('./dialogues-api');
 const {reviewCard}=await import('./components-review-fixtures');
 const card={...reviewCard,assigneeSessionId:null,folderId:'old',nodeId:'sample-node',assigneeAgentId:'roselin',modelPreset:null};
 const saved={...card,folderId:'destination',version:card.version+1};
 let moved=false,listReads=0;
 vi.stubGlobal('fetch',vi.fn(async(input:unknown)=>({ok:true,json:async()=>{
  if(String(input).startsWith('/api/cards?')){listReads++;return {cards:moved?[saved]:[]};}
  return {agents:[],model_presets:[]};
 }})));
 function Destination(){const membership=useCardMembership('destination');return <div data-destination>{membership.cards.map(item=>item.id).join(',')}</div>;}
 await act(()=>root.render(<QueryClientProvider client={new QueryClient()}><Destination/><CardExecutionSettingsDialog card={card} folders={[{id:'old',name:'기존'},{id:'destination',name:'대상'}] as any} assignment={dialoguesAssignment} onSave={async()=>{moved=true;return saved;}} onClose={()=>{}}/></QueryClientProvider>));
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,30));});
 expect(listReads).toBe(1);
 await act(async()=>{document.querySelector<HTMLButtonElement>('[aria-label="카드 설정 저장"]')!.click();await Promise.resolve();});
 expect(listReads).toBe(2);
 expect(container.querySelector('[data-destination]')?.textContent).toContain(saved.id);
});


it.each([true,false])('saves title and folder without execution settings (available nodes: %s)', async available=>{
 const {CardCreateDialog}=await import('./CardCreateDialog');
 const onSave=vi.fn().mockResolvedValue({id:'draft'}),onClose=vi.fn();
 if(!available)useOrchestratorStore.setState({nodes:new Map()});
 await act(()=>root.render(<QueryClientProvider client={new QueryClient()}><CardCreateDialog folders={[{id:'f',name:'폴더'} as any]} initialFolderId="f" onSave={onSave} onClose={onClose}/></QueryClientProvider>));
 const title=document.querySelector<HTMLInputElement>('[aria-label="카드 제목"]')!;
 await act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(title,'제목만');title.dispatchEvent(new Event('input',{bubbles:true}));});
 const save=document.querySelector<HTMLButtonElement>('[aria-label="카드 저장"]')!;
 expect(save.disabled).toBe(false);
 await act(async()=>{save.click();await Promise.resolve();});
 expect(onSave).toHaveBeenCalledWith(expect.objectContaining({title:'제목만',folderId:'f',request:'',nodeId:null,assignee:null,modelPreset:null,attachments:[],queue:false}));
 expect(onClose).toHaveBeenCalledTimes(1);
});


it('keeps execution settings save inside its modal when rendered by a clickable card',async()=>{
 const {CardExecutionSettingsDialog}=await import('./CardExecutionSettings');
 const {dialoguesAssignment}=await import('./dialogues-api');
 const {reviewCard}=await import('./components-review-fixtures');
 const card={...reviewCard,folderId:'f',assigneeSessionId:null,nodeId:'sample-node',assigneeAgentId:'roselin',modelPreset:'sample-sol'};
 const outside=vi.fn();
 await act(()=>root.render(<QueryClientProvider client={new QueryClient()}><div onClick={outside}><CardExecutionSettingsDialog card={card} folders={[{id:'f',name:'폴더'} as any]} assignment={dialoguesAssignment} startAfterSave onSave={async()=>card} onStart={async()=>{}} onClose={()=>{}}/></div></QueryClientProvider>));
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,30));});
 await act(async()=>{document.querySelector<HTMLButtonElement>('[aria-label="카드 설정 저장"]')!.click();await Promise.resolve();});
 expect(outside).not.toHaveBeenCalled();
});

const executionAssignment=(presets:unknown[]=[{id:'sol',label:'Sol',backend:'codex',available:true,reason:null,reason_label:null,resets_at:null,usage_warning:false}])=>({
 nodes:[{nodeId:'n',status:'connected'}],agents:[{id:'a',name:'에이전트',backend:'codex',default_preset:''}],
 modelPresetCatalog:{status:'ready' as const,nodeId:'n',presets:presets as any},
});
async function renderExecutionSettings(props:{startAfterSave?:boolean;modelPreset?:string|null;onSave?:any;onStart?:any;assignment?:any}={}){
 const {CardExecutionSettingsDialog}=await import('./CardExecutionSettings');
 const {reviewCard}=await import('./components-review-fixtures');
 const card={...reviewCard,assigneeSessionId:null,folderId:'f',nodeId:'n',assigneeAgentId:'a',modelPreset:props.modelPreset??null};
 const close=vi.fn();
 await act(()=>root.render(<QueryClientProvider client={new QueryClient()}><CardExecutionSettingsDialog card={card} folders={[{id:'f',name:'폴더'} as any]} assignment={props.assignment??executionAssignment()} startAfterSave={props.startAfterSave} onSave={props.onSave??(async()=>({...card,version:card.version+1}))} onStart={props.onStart} onClose={close}/></QueryClientProvider>));
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,30));});
 return {card,close,button:()=>document.querySelector<HTMLButtonElement>('[aria-label="카드 설정 저장"]')!};
}
it('keeps 저장 후 실행 off until a model is chosen',async()=>{
 const unchosen=await renderExecutionSettings({startAfterSave:true});
 expect(unchosen.button().textContent).toBe('저장 후 실행');
 expect(unchosen.button().disabled).toBe(true);
});

it('shows 모델 선택 and marks the 실행 환경 invalid when 저장 후 실행 has no model',async()=>{
 await renderExecutionSettings({startAfterSave:true});
 const summary=document.querySelector('details summary')!;
 expect(summary.textContent).toContain('모델 선택');
 expect(summary.textContent).not.toContain('기본 모델');
 expect(summary.textContent).toContain('선택을 확인하세요');
});

it('keeps 기본 모델 and no invalid mark when the settings are only saved',async()=>{
 await renderExecutionSettings({startAfterSave:false});
 const summary=document.querySelector('details summary')!;
 expect(summary.textContent).toContain('기본 모델');
 expect(summary.textContent).not.toContain('선택을 확인하세요');
});

it('turns 저장 후 실행 on once the card has a usable model',async()=>{
 const chosen=await renderExecutionSettings({startAfterSave:true,modelPreset:'sol'});
 expect(chosen.button().disabled).toBe(false);
});

it('still lets execution settings be saved without a model when no start follows',async()=>{
 const plain=await renderExecutionSettings({startAfterSave:false});
 expect(plain.button().textContent).toBe('설정 저장');
 expect(plain.button().disabled).toBe(false);
});

it('tells the user the settings were saved when the server refuses to start, then lets the retry go through',async()=>{
 const reason='폴더·노드·에이전트·모델을 선택한 뒤 실행하세요.';
 const onStart=vi.fn().mockRejectedValueOnce(new CardApiError(reason,422)).mockResolvedValue(undefined);
 const dialog=await renderExecutionSettings({startAfterSave:true,modelPreset:'sol',onStart});
 await act(async()=>{dialog.button().click();await new Promise(resolve=>setTimeout(resolve,10));});
 const alert=document.querySelector('[role="alert"]')!;
 expect(alert.textContent).toContain(`저장했지만 시작하지 못했습니다: ${reason}`);
 expect(alert.textContent).not.toContain('카드를 저장하지 못했습니다');
 expect(dialog.close).not.toHaveBeenCalled();
 expect(dialog.button().disabled).toBe(false);
 await act(async()=>{dialog.button().click();await new Promise(resolve=>setTimeout(resolve,10));});
 expect(onStart).toHaveBeenCalledTimes(2);
 expect(dialog.close).toHaveBeenCalledTimes(1);
});

it('saves the retry on the version the first save produced',async()=>{
 const {reviewCard}=await import('./components-review-fixtures');
 const bodies:any[]=[];
 vi.stubGlobal('fetch',vi.fn(async(input:unknown,init?:RequestInit)=>{
  if(String(input).endsWith('/execution-settings')){
   const body=JSON.parse(String(init?.body));bodies.push(body);
   return {ok:true,json:async()=>({card:{...reviewCard,assigneeSessionId:null,folderId:'f',nodeId:'n',assigneeAgentId:'a',modelPreset:'sol',version:body.expectedVersion+1}})};
  }
  return {ok:true,json:async()=>({cards:[]})};
 }));
 const onStart=vi.fn().mockRejectedValueOnce(new CardApiError('거절',422)).mockResolvedValue(undefined);
 const {CardExecutionSettingsDialog}=await import('./CardExecutionSettings');
 const card={...reviewCard,assigneeSessionId:null,folderId:'f',nodeId:'n',assigneeAgentId:'a',modelPreset:'sol'};
 await act(()=>root.render(<QueryClientProvider client={new QueryClient()}><CardExecutionSettingsDialog card={card} folders={[{id:'f',name:'폴더'} as any]} assignment={executionAssignment()} startAfterSave onStart={onStart} onClose={()=>{}}/></QueryClientProvider>));
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,30));});
 const button=()=>document.querySelector<HTMLButtonElement>('[aria-label="카드 설정 저장"]')!;
 await act(async()=>{button().click();await new Promise(resolve=>setTimeout(resolve,10));});
 await act(async()=>{button().click();await new Promise(resolve=>setTimeout(resolve,10));});
 expect(bodies.map(body=>body.expectedVersion)).toEqual([card.version,card.version+1]);
});

it('shows a save failure as a save failure, not a refused start',async()=>{
 const dialog=await renderExecutionSettings({startAfterSave:true,modelPreset:'sol',onSave:async()=>{throw new CardApiError('저장 실패',422);},onStart:vi.fn()});
 await act(async()=>{dialog.button().click();await new Promise(resolve=>setTimeout(resolve,10));});
 expect(document.querySelector('[role="alert"]')!.textContent).toContain('카드를 저장하지 못했습니다.');
 expect(document.body.textContent).not.toContain('저장했지만 시작하지 못했습니다');
});

it('tells the user there is no usable model when the node has none',async()=>{
 await renderExecutionSettings({assignment:executionAssignment([{id:'sol',label:'Sol',backend:'codex',available:false,reason:'not_authenticated',reason_label:'미인증',resets_at:null,usage_warning:false}])});
 expect(document.body.textContent).toContain('쓸 수 있는 모델이 없습니다. 설정의 「코딩 에이전트 연결」에서 이 노드의 로그인을 확인하세요.');
});
