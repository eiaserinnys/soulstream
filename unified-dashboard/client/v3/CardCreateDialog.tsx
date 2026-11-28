import { useTranslation } from "react-i18next";
import {CreationDisclosure} from "./CreationDisclosure";
import {useCallback,useRef,useState} from "react";
import {Button,Dialog,DialogPopup,DialogHeader,DialogTitle,DialogPanel,DialogFooter,Input,Popover,PopoverTrigger,PopoverPopup,useFileUpload,type AgentInfo,type CatalogFolder} from "@seosoyoung/soul-ui";
import {useCardStore} from "@seosoyoung/soul-ui/cards/card-store";
import {CardApiError,cardMutationKey} from "@seosoyoung/soul-ui/cards/card-api";
import type { CardAttachment } from "../../../packages/wire-schema/src/card_attachments";
import type {UseFileUploadReturn} from "@seosoyoung/soul-ui/hooks/useFileUpload";
import type {ModelPresetAvailability} from "@seosoyoung/soul-ui/lib/model-preset-availability";
import {useTextareaAutoHeight} from "@seosoyoung/soul-ui/components/chat/useTextareaAutoHeight";
import {handleClipboardFiles} from "@seosoyoung/soul-ui/lib/clipboard-files";
import {AgentNodeAssignmentFields} from "./AgentNodeAssignmentFields";
import {SessionAttachmentFields} from "./SessionAttachmentFields";
import {FolderPicker} from "./FolderPicker";
import {useFolderPickerStars} from "./use-folder-picker-stars";
import {V3ErrorNotice} from "./V3ErrorNotice";

/** The execution settings were saved, but the server refused to start the card. */
export class CardStartRefusedError extends Error {}

export interface CreateCardInput {
 folderId:string;title:string;request:string;nodeId:string|null;assignee:{kind:"agent";agentId:string}|null;modelPreset:string|null;
 attachments:CardAttachment[];queue:false;idempotencyKey:string;
}
export function CardCreateDialog({folders,initialFolderId="",onClose,onCreated,onSave,uploadController,assignment,starredFolderIds,executionSettings}: {
 executionSettings?:{card:import("@seosoyoung/soul-ui/cards/card-types").CardRow;startAfterSave?:boolean;onSave(value:import("@seosoyoung/soul-ui/cards/card-execution").CardExecutionSettings,key:string):Promise<void>};
 assignment?:import("./AgentNodeAssignmentFields").AssignmentData;starredFolderIds?:readonly string[];
 folders:readonly CatalogFolder[];initialFolderId?:string;onClose():void;onCreated?(id:string):void;
 onSave?(input:CreateCardInput):Promise<{id:string}>;uploadController?:UseFileUploadReturn;
}) {
 const {t}=useTranslation();
 const [title,setTitle]=useState(""),[request,setRequest]=useState(""),[folderId,setFolderId]=useState(executionSettings?.card.folderId??initialFolderId);
 const [nodeId,setNodeId]=useState(executionSettings?.card.nodeId??""),[agentId,setAgentId]=useState(executionSettings?.card.assigneeAgentId??""),[agent,setAgent]=useState<AgentInfo|null>(null),[modelPreset,setModelPreset]=useState(executionSettings?.card.modelPreset??""),[modelInfo,setModelInfo]=useState<ModelPresetAvailability|null>(null),[valid,setValid]=useState(false);
 const [folderOpen,setFolderOpen]=useState(false),[pending,setPending]=useState(false),[error,setError]=useState<string|null>(null);
 const [uncertain,setUncertain]=useState(false),[startRefused,setStartRefused]=useState(false);
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
 const ready=!pending&&(uncertain?!!attempt.current:executionSettings?(!!folderId&&(!modelPreset||valid)&&(!executionSettings.startAfterSave||!!nodeId&&!!agentId&&!!modelPreset&&valid)):!!title.trim()&&!!folderId&&upload.isReady&&(!upload.files.length||!!nodeId));
 const close=async()=>{if(submitting.current||attempt.current)return;await upload.cancel();onClose();};
 const save=async()=>{
  if(!ready||submitting.current||completed.current)return;submitting.current=true;setPending(true);setError(null);setStartRefused(false);
  try {
   if(!attempt.current)attempt.current={idempotencyKey:cardMutationKey(),folderId,title:title.trim(),request,nodeId:nodeId||null,assignee:agentId?{kind:"agent" as const,agentId}:null,modelPreset:modelPreset||null,queue:false as const,
    attachments:upload.files.map(file=>({nodeId,path:file.path!,name:file.file.name,mimeType:file.file.type||"application/octet-stream"}))};
   const input=attempt.current;
   if(executionSettings){
    await executionSettings.onSave({folderId:input.folderId,nodeId:input.nodeId||null,agentId:input.assignee?.agentId||null,modelPreset:input.modelPreset},input.idempotencyKey);
    completed.current=true;onClose();return;
   }
   const card=await (onSave?onSave(input):useCardStore.getState().create(input,t));
   completed.current=true;upload.resetLocal();onCreated?.(card.id);onClose();
  }catch(cause){
   const rejected=cause instanceof CardStartRefusedError||cause instanceof CardApiError&&[400,403,404,422,...(executionSettings?[409]:[])].includes(cause.status);
   if(rejected)attempt.current=null;
   setUncertain(!rejected);setStartRefused(cause instanceof CardStartRefusedError);setError(cause instanceof Error?cause.message:String(cause));
  }finally{submitting.current=false;setPending(false);}
 };
 const uploadError=upload.files.find(file=>file.status==="error")?.errorMessage;
 return <Dialog open onOpenChange={open=>{if(!open)void close();}}>
  <DialogPopup onClick={event=>event.stopPropagation()} className="v3-surface v3-succession-modal v3-card-create-dialog max-w-[640px]" closeProps={{"aria-label":executionSettings?t("cards.closeExecutionSettings"):t("cards.closeCreate"),disabled:locked}}>
   <DialogHeader className="v3-succession-head"><span aria-hidden="true">＋</span><DialogTitle>{executionSettings?t("cards.executionSettings"):t("cards.newCard")}</DialogTitle></DialogHeader>
   <DialogPanel className="v3-succession-body" scrollFade={false}>
    {error||uploadError?<V3ErrorNotice className="v3-succession-error" message={error?(uncertain?t("cards.saveUnconfirmed"):startRefused?t("cards.savedStartError", {error}):t("cards.saveError")):t("cards.attachmentUploadError")} detail={startRefused?null:error||uploadError}/>:null}
    {uncertain?<p role="status" className="v3-form-intent" data-v3-selectable-content="true">{t("cards.saveUnconfirmedHint")}</p>:null}
    <div className="v3-succession-context-editor">
     <section><strong>{t("cards.folder")}</strong><Popover open={folderOpen} onOpenChange={setFolderOpen}><PopoverTrigger render={<Button variant="outline" disabled={locked}/>} aria-label={t("cards.selectFolder")}>{folders.find(f=>f.id===folderId)?.name??t("cards.selectFolder")}</PopoverTrigger>
      <PopoverPopup className="v3-surface v3-card-folder-picker" side="bottom" align="start"><FolderPicker folders={folders} starredFolderIds={stars.folderIds} selectedFolderId={folderId} disabledFolderIds={new Set(["claude","llm"])} pending={locked} onSelect={folder=>{if(attempt.current)return;setFolderId(folder.id);setFolderOpen(false);}}/></PopoverPopup>
     </Popover></section>
     <p className="v3-form-intent">{executionSettings?(executionSettings.startAfterSave?t("cards.saveAndRunHint"):t("cards.saveSettingsHint")):t("cards.saveDraftHint")}</p>
     {!executionSettings?<>

     <label className="v3-creation-text-field"><strong>{t("cards.title")}</strong><Input autoFocus aria-label={t("cards.title")} placeholder={t("cards.title")} value={title} onChange={event=>{if(!attempt.current)setTitle(event.target.value);}} disabled={locked}/></label>
     <label className="v3-creation-text-field"><strong>{t("cards.requestBody")} <small>{t("cards.optional")}</small></strong><textarea ref={textarea} aria-label={t("cards.rawRequest")} placeholder={t("cards.requestPlaceholder")} rows={1} className="v3-creation-request max-h-[120px]" value={request} disabled={locked} onChange={event=>{if(!attempt.current)setRequest(event.target.value);}} onPaste={event=>{if(nodeId&&!locked)handleClipboardFiles(event,upload.addFiles);}}/></label>
     <fieldset className="contents" disabled={locked}><SessionAttachmentFields files={upload.files} pending={locked} nodeId={nodeId} isUploading={upload.isUploading} addFiles={files=>{if(!attempt.current)upload.addFiles(files);}} removeFile={id=>{if(!attempt.current)upload.removeFile(id);}}/></fieldset>
     </>:null}
     <CreationDisclosure title={executionSettings?t("cards.executionEnvironment"):t("cards.executionEnvironmentOptional")} invalid={!!executionSettings&&(!valid || !nodeId || !agentId || (!!executionSettings.startAfterSave&&!modelPreset))} summary={`${agent?.name ?? t("cards.selectAgent")} · ${nodeId || t("cards.selectNode")} · ${modelInfo?.label ?? (modelPreset || (executionSettings?.startAfterSave?t("cards.selectModel"):t("cards.defaultModel")))}`}><section><AgentNodeAssignmentFields data={assignment} fallbackToAvailable={!!executionSettings} nodeId={nodeId} agentId={agentId} modelPreset={modelPreset} disabled={locked}
      onNodeIdChange={onNodeChange} onAgentIdChange={value=>{if(!attempt.current)setAgentId(value);}} onAgentInfoChange={onAgentChange} onModelPresetChange={onPresetChange} onModelPresetInfoChange={setModelInfo} onModelPresetValidityChange={setValid} onError={setError}/></section></CreationDisclosure>

    </div>
   </DialogPanel>
   <DialogFooter className="v3-succession-footer"><p className="v3-form-submit-note">{executionSettings?t("cards.saveToCard"):t("cards.saveDraftLater")}</p><Button variant="ghost" disabled={locked} onClick={()=>void close()}>{t("cards.cancel")}</Button><Button aria-label={executionSettings?t("cards.saveCardSettings"):t("cards.saveCard")} disabled={!ready} onClick={()=>void save()}>{pending?(uncertain?t("cards.checkingSave"):t("cards.saving")):uncertain?t("cards.retrySubmission"):upload.isUploading?t("cards.attaching"):executionSettings?(executionSettings.startAfterSave?t("cards.saveAndRun"):t("cards.saveSettings")):t("cards.saveDraft")}</Button></DialogFooter>
  </DialogPopup>
 </Dialog>;
}
