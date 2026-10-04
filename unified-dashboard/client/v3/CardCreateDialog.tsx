import {CreationDisclosure} from "./CreationDisclosure";
import {useCallback,useRef,useState} from "react";
import {Button,Dialog,DialogPopup,DialogHeader,DialogTitle,DialogPanel,DialogFooter,Input,Popover,PopoverTrigger,PopoverPopup,useFileUpload,type AgentInfo,type CatalogFolder} from "@seosoyoung/soul-ui";
import {useCardStore} from "@seosoyoung/soul-ui/cards/card-store";
import {CardApiError,cardMutationKey} from "@seosoyoung/soul-ui/cards/card-api";
import type {CardAttachment} from "@seosoyoung/soul-ui/cards/card-types";
import type {UseFileUploadReturn} from "@seosoyoung/soul-ui/hooks/useFileUpload";
import {useTextareaAutoHeight} from "@seosoyoung/soul-ui/components/chat/useTextareaAutoHeight";
import {handleClipboardFiles} from "@seosoyoung/soul-ui/lib/clipboard-files";
import {AgentNodeAssignmentFields} from "./AgentNodeAssignmentFields";
import {SessionAttachmentFields} from "./SessionAttachmentFields";
import {FolderPicker} from "./FolderPicker";
import {useFolderPickerStars} from "./use-folder-picker-stars";
import {V3ErrorNotice} from "./V3ErrorNotice";

export interface CreateCardInput {
 folderId:string;title:string;request:string;nodeId:string;assignee:{kind:"agent";agentId:string};modelPreset:string|null;
 attachments:CardAttachment[];queue:false;idempotencyKey:string;
}
export function CardCreateDialog({folders,initialFolderId="",onClose,onCreated,onSave,uploadController,assignment,starredFolderIds,executionSettings}: {
 executionSettings?:{card:import("@seosoyoung/soul-ui/cards/card-types").CardRow;startAfterSave?:boolean;onSave(value:import("@seosoyoung/soul-ui/cards/card-execution").CardExecutionSettings,key:string):Promise<void>};
 assignment?:import("./AgentNodeAssignmentFields").AssignmentData;starredFolderIds?:readonly string[];
 folders:readonly CatalogFolder[];initialFolderId?:string;onClose():void;onCreated?(id:string):void;
 onSave?(input:CreateCardInput):Promise<{id:string}>;uploadController?:UseFileUploadReturn;
}) {
 const [title,setTitle]=useState(""),[request,setRequest]=useState(""),[folderId,setFolderId]=useState(executionSettings?.card.folderId??initialFolderId);
 const [nodeId,setNodeId]=useState(executionSettings?.card.nodeId??""),[agentId,setAgentId]=useState(executionSettings?.card.assigneeAgentId??""),[agent,setAgent]=useState<AgentInfo|null>(null),[modelPreset,setModelPreset]=useState(executionSettings?.card.modelPreset??""),[valid,setValid]=useState(false);
 const [folderOpen,setFolderOpen]=useState(false),[pending,setPending]=useState(false),[error,setError]=useState<string|null>(null);
 const [uncertain,setUncertain]=useState(false);
 const [uploadSessionId]=useState(()=>crypto.randomUUID());
 const submitting=useRef(false),completed=useRef(false);
 const attempt=useRef<CreateCardInput|null>(null);
 const explicitPreset=useRef(!!executionSettings?.card.modelPreset),textarea=useRef<HTMLTextAreaElement>(null);
 const localUpload=useFileUpload({uploadUrl:nodeId&&!uploadController?`/api/attachments/sessions?nodeId=${encodeURIComponent(nodeId)}`:"",sessionId:uploadSessionId,folderId:folderId||null});
 const upload=uploadController??localUpload;
 const stars=useFolderPickerStars(folderOpen,folders,starredFolderIds);
 useTextareaAutoHeight(textarea,request,14);
 const onNodeChange=useCallback((value:string)=>{if(attempt.current)return;setNodeId(value);setAgent(null);setModelPreset("");setValid(false);explicitPreset.current=false;},[]);
 const onAgentChange=useCallback((value:AgentInfo|null)=>{if(attempt.current)return;setAgent(value);if(!explicitPreset.current)setModelPreset(value?.default_preset??"");},[]);
 const onPresetChange=useCallback((value:string)=>{if(attempt.current)return;explicitPreset.current=true;setModelPreset(value);},[]);
 const locked=pending||uncertain;
 const ready=!pending&&(uncertain?!!attempt.current:executionSettings?(!!folderId&&(!modelPreset||valid)&&(!executionSettings.startAfterSave||!!nodeId&&!!agentId&&valid)):!!title.trim()&&!!folderId&&!!nodeId&&agent?.id===agentId&&valid&&upload.isReady);
 const close=async()=>{if(submitting.current||attempt.current)return;await upload.cancel();onClose();};
 const save=async()=>{
  if(!ready||submitting.current||completed.current)return;submitting.current=true;setPending(true);setError(null);
  try {
   if(!attempt.current)attempt.current={idempotencyKey:cardMutationKey(),folderId,title:title.trim(),request,nodeId,assignee:{kind:"agent" as const,agentId},modelPreset:modelPreset||null,queue:false as const,
    attachments:upload.files.map(file=>({nodeId,path:file.path!,name:file.file.name,mimeType:file.file.type||"application/octet-stream"}))};
   const input=attempt.current;
   if(executionSettings){
    await executionSettings.onSave({folderId:input.folderId,nodeId:input.nodeId||null,agentId:input.assignee.agentId||null,modelPreset:input.modelPreset},input.idempotencyKey);
    completed.current=true;onClose();return;
   }
   const card=await (onSave??useCardStore.getState().create)(input);
   completed.current=true;upload.resetLocal();onCreated?.(card.id);onClose();
  }catch(cause){
   const rejected=cause instanceof CardApiError&&[400,403,404,422,...(executionSettings?[409]:[])].includes(cause.status);
   if(rejected)attempt.current=null;
   setUncertain(!rejected);setError(cause instanceof Error?cause.message:String(cause));
  }finally{submitting.current=false;setPending(false);}
 };
 const uploadError=upload.files.find(file=>file.status==="error")?.errorMessage;
 return <Dialog open onOpenChange={open=>{if(!open)void close();}}>
  <DialogPopup className="v3-surface v3-succession-modal v3-card-create-dialog max-w-[640px]" closeProps={{"aria-label":executionSettings?"카드 설정 닫기":"새 카드 닫기",disabled:locked}}>
   <DialogHeader className="v3-succession-head"><span aria-hidden="true">＋</span><DialogTitle>{executionSettings?"카드 실행 설정":"새 카드"}</DialogTitle></DialogHeader>
   <DialogPanel className="v3-succession-body" scrollFade={false}>
    {error||uploadError?<V3ErrorNotice className="v3-succession-error" message={error?(uncertain?"카드 저장 결과를 확인하지 못했습니다.":"카드를 저장하지 못했습니다."):"첨부를 업로드하지 못했습니다."} detail={error||uploadError}/>:null}
    {uncertain?<p role="status" className="v3-form-intent">이미 저장되었을 수 있습니다. 같은 제출로 저장 결과를 확인할 때까지 입력과 첨부를 유지합니다.</p>:null}
    <div className="v3-succession-context-editor">
     <section><strong>폴더</strong><Popover open={folderOpen} onOpenChange={setFolderOpen}><PopoverTrigger render={<Button variant="outline" disabled={locked}/>} aria-label="폴더 선택">{folders.find(f=>f.id===folderId)?.name??"폴더 선택"}</PopoverTrigger>
      <PopoverPopup className="v3-surface v3-card-folder-picker" side="bottom" align="start"><FolderPicker folders={folders} starredFolderIds={stars.folderIds} selectedFolderId={folderId} disabledFolderIds={new Set(["claude","llm"])} pending={locked} onSelect={folder=>{if(attempt.current)return;setFolderId(folder.id);setFolderOpen(false);}}/></PopoverPopup>
     </Popover></section>
     <p className="v3-form-intent">{executionSettings?(executionSettings.startAfterSave?"설정을 저장한 뒤 카드를 실행합니다.":"카드 실행 설정을 저장합니다."):"할 일을 드래프트로 남깁니다. 저장해도 바로 실행되지 않습니다."}</p>
     {!executionSettings?<>

     <label><strong>카드 제목</strong><Input autoFocus aria-label="카드 제목" placeholder="카드 제목" value={title} onChange={event=>{if(!attempt.current)setTitle(event.target.value);}} disabled={locked}/></label>
     <label><strong>요청 내용 <small>선택</small></strong><textarea ref={textarea} aria-label="요청 원문" placeholder="수행할 요청을 적어주세요" rows={1} className="max-h-[120px]" value={request} disabled={locked} onChange={event=>{if(!attempt.current)setRequest(event.target.value);}} onPaste={event=>{if(nodeId&&!locked)handleClipboardFiles(event,upload.addFiles);}}/></label>
     <fieldset className="contents" disabled={locked}><SessionAttachmentFields files={upload.files} pending={locked} nodeId={nodeId} isUploading={upload.isUploading} addFiles={files=>{if(!attempt.current)upload.addFiles(files);}} removeFile={id=>{if(!attempt.current)upload.removeFile(id);}}/></fieldset>
     </>:null}
     <CreationDisclosure title="실행 환경" invalid={!valid || !nodeId || !agentId} summary={`${nodeId || "노드 선택"} / ${agent?.name ?? "에이전트 선택"} / ${modelPreset || "기본 모델"}`}><section><AgentNodeAssignmentFields data={assignment} presentation="session" fallbackToAvailable nodeId={nodeId} agentId={agentId} modelPreset={modelPreset} disabled={locked}
      onNodeIdChange={onNodeChange} onAgentIdChange={value=>{if(!attempt.current)setAgentId(value);}} onAgentInfoChange={onAgentChange} onModelPresetChange={onPresetChange} onModelPresetValidityChange={setValid} onError={setError}/></section></CreationDisclosure>

    </div>
   </DialogPanel>
   <DialogFooter className="v3-succession-footer"><p className="v3-form-submit-note">{executionSettings?"카드에 저장":"드래프트에 저장 / 실행은 나중에"}</p><Button variant="ghost" disabled={locked} onClick={()=>void close()}>취소</Button><Button aria-label={executionSettings?"카드 설정 저장":"카드 저장"} disabled={!ready} onClick={()=>void save()}>{pending?(uncertain?"저장 결과 확인 중…":"저장 중…"):uncertain?"같은 제출로 다시 확인":upload.isUploading?"첨부 중…":executionSettings?(executionSettings.startAfterSave?"저장 후 실행":"설정 저장"):"드래프트 저장"}</Button></DialogFooter>
  </DialogPopup>
 </Dialog>;
}
