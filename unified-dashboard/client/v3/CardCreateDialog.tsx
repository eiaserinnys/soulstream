import {useCallback,useRef,useState} from "react";
import {Button,Dialog,DialogPopup,DialogHeader,DialogTitle,DialogPanel,DialogFooter,Input,Popover,PopoverTrigger,PopoverPopup,useFileUpload,type AgentInfo,type CatalogFolder} from "@seosoyoung/soul-ui";
import {useCardStore} from "@seosoyoung/soul-ui/cards/card-store";
import {cardMutationKey} from "@seosoyoung/soul-ui/cards/card-api";
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
export function CardCreateDialog({folders,initialFolderId="",onClose,onCreated,onSave,uploadController,assignment,starredFolderIds}: {
 assignment?:import("./AgentNodeAssignmentFields").AssignmentData;starredFolderIds?:readonly string[];
 folders:readonly CatalogFolder[];initialFolderId?:string;onClose():void;onCreated?(id:string):void;
 onSave?(input:CreateCardInput):Promise<{id:string}>;uploadController?:UseFileUploadReturn;
}) {
 const [title,setTitle]=useState(""),[request,setRequest]=useState(""),[folderId,setFolderId]=useState(initialFolderId);
 const [nodeId,setNodeId]=useState(""),[agentId,setAgentId]=useState(""),[agent,setAgent]=useState<AgentInfo|null>(null),[modelPreset,setModelPreset]=useState(""),[valid,setValid]=useState(false);
 const [folderOpen,setFolderOpen]=useState(false),[pending,setPending]=useState(false),[error,setError]=useState<string|null>(null);
 const [uploadSessionId]=useState(()=>crypto.randomUUID()),[idempotencyKey]=useState(cardMutationKey);
 const explicitPreset=useRef(false),textarea=useRef<HTMLTextAreaElement>(null);
 const localUpload=useFileUpload({uploadUrl:nodeId&&!uploadController?`/api/attachments/sessions?nodeId=${encodeURIComponent(nodeId)}`:"",sessionId:uploadSessionId,folderId:folderId||null});
 const upload=uploadController??localUpload;
 const stars=useFolderPickerStars(folderOpen,folders,starredFolderIds);
 useTextareaAutoHeight(textarea,request,14);
 const onNodeChange=useCallback((value:string)=>{setNodeId(value);setAgent(null);setModelPreset("");setValid(false);explicitPreset.current=false;},[]);
 const onAgentChange=useCallback((value:AgentInfo|null)=>{setAgent(value);if(!explicitPreset.current)setModelPreset(value?.default_preset??"");},[]);
 const onPresetChange=useCallback((value:string)=>{explicitPreset.current=true;setModelPreset(value);},[]);
 const ready=!!title.trim()&&!!folderId&&!!nodeId&&agent?.id===agentId&&valid&&upload.isReady&&!pending;
 const close=async()=>{if(pending)return;await upload.cancel();onClose();};
 const save=async()=>{
  if(!ready)return;setPending(true);setError(null);
  try {
   const input:CreateCardInput={folderId,title:title.trim(),request,nodeId,assignee:{kind:"agent",agentId},modelPreset:modelPreset||null,queue:false,idempotencyKey,
    attachments:upload.files.map(file=>({nodeId,path:file.path!,name:file.file.name,mimeType:file.file.type||"application/octet-stream"}))};
   const card=await (onSave??useCardStore.getState().create)(input);
   upload.resetLocal();onCreated?.(card.id);onClose();
  }catch(cause){setError(cause instanceof Error?cause.message:String(cause));}finally{setPending(false);}
 };
 const uploadError=upload.files.find(file=>file.status==="error")?.errorMessage;
 return <Dialog open onOpenChange={open=>{if(!open)void close();}}>
  <DialogPopup className="v3-surface v3-succession-modal v3-card-create-dialog max-w-[640px]" closeProps={{"aria-label":"새 카드 닫기",disabled:pending}}>
   <DialogHeader className="v3-succession-head"><span aria-hidden="true">＋</span><DialogTitle>새 카드</DialogTitle></DialogHeader>
   <DialogPanel className="v3-succession-body" scrollFade={false}>
    {error||uploadError?<V3ErrorNotice className="v3-succession-error" message={error?"카드를 저장하지 못했습니다.":"첨부를 업로드하지 못했습니다."} detail={error||uploadError}/>:null}
    <div className="v3-succession-context-editor">
     <label><strong>카드 제목</strong><Input autoFocus aria-label="카드 제목" placeholder="카드 제목" value={title} onChange={event=>setTitle(event.target.value)} disabled={pending}/></label>
     <label><strong>요청 원문</strong><textarea ref={textarea} aria-label="요청 원문" placeholder="수행할 요청을 적어주세요" rows={1} className="max-h-[120px]" value={request} disabled={pending} onChange={event=>setRequest(event.target.value)} onPaste={event=>{if(nodeId&&!pending)handleClipboardFiles(event,upload.addFiles);}}/></label>
     <section><strong>폴더</strong><Popover open={folderOpen} onOpenChange={setFolderOpen}><PopoverTrigger render={<Button variant="outline" disabled={pending}/>} aria-label="폴더 선택">{folders.find(f=>f.id===folderId)?.name??"폴더 선택"}</PopoverTrigger>
      <PopoverPopup className="v3-surface v3-card-folder-picker" side="bottom" align="start"><FolderPicker folders={folders} starredFolderIds={stars.folderIds} selectedFolderId={folderId} disabledFolderIds={new Set(["claude","llm"])} pending={pending} onSelect={folder=>{setFolderId(folder.id);setFolderOpen(false);}}/></PopoverPopup>
     </Popover></section>
     <section><strong>노드 / 에이전트 / 모델</strong><AgentNodeAssignmentFields data={assignment} presentation="session" fallbackToAvailable nodeId={nodeId} agentId={agentId} modelPreset={modelPreset} disabled={pending}
      onNodeIdChange={onNodeChange} onAgentIdChange={setAgentId} onAgentInfoChange={onAgentChange} onModelPresetChange={onPresetChange} onModelPresetValidityChange={setValid} onError={setError}/></section>
     <SessionAttachmentFields files={upload.files} pending={pending} nodeId={nodeId} isUploading={upload.isUploading} addFiles={upload.addFiles} removeFile={upload.removeFile}/>
    </div>
   </DialogPanel>
   <DialogFooter className="v3-succession-footer"><Button variant="ghost" disabled={pending} onClick={()=>void close()}>취소</Button><Button aria-label="카드 저장" disabled={!ready} onClick={()=>void save()}>{pending?"저장 중…":upload.isUploading?"첨부 중…":"저장"}</Button></DialogFooter>
  </DialogPopup>
 </Dialog>;
}
