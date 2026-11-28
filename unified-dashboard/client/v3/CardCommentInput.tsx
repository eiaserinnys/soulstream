import { useTranslation } from "react-i18next";
import { useState } from "react";
import { useDashboardStore } from "@seosoyoung/soul-ui";
import { useFileUpload } from "@seosoyoung/soul-ui/hooks/useFileUpload";
import { CardComposer } from "./CardComposer";

export function CardCommentInput({cardId,nodeId,sessionId,pending,onSend,uploadController,focusRequest=0,kind,placeholder}:{uploadController?:import("@seosoyoung/soul-ui/hooks/useFileUpload").UseFileUploadReturn;cardId:string;nodeId?:string|null;sessionId?:string|null;pending:boolean;onSend(body:string):Promise<boolean>;focusRequest?:number;kind:"comment"|"answer";placeholder?:string}) {
 const {t}=useTranslation();
 const draftKey=`composer:card-comment:${cardId}`;
 const text=useDashboardStore(s=>s.drafts[draftKey]??"");
 const setDraft=useDashboardStore(s=>s.setDraft);
 const [notice,setNotice]=useState("");
 const uploadUrl=nodeId&&sessionId?`/api/attachments/sessions?nodeId=${encodeURIComponent(nodeId)}`:"";
 const localUpload=useFileUpload({uploadUrl:uploadController?"":uploadUrl,sessionId:sessionId??""});
 const upload=uploadController??localUpload;
 const ready=!pending&&!upload.isUploading&&!upload.files.some(file=>file.status==="error")&&Boolean(text.trim()||upload.files.length);
 const submit=async()=>{
  if(!ready)return;
  const submittedKey=draftKey,submittedText=text;
  const attachments=upload.files.flatMap(file=>{
   if(!file.path)return [];
   const url=`/api/attachments/files?nodeId=${encodeURIComponent(nodeId!)}&path=${encodeURIComponent(file.path)}`;
   const label=file.file.name.replace(/[\[\]\\]/g,"\\$&");
   return [`${file.file.type.startsWith("image/")?"!":""}[${label}](${url})`];
  });
  if(await onSend([text.trim(),...attachments].filter(Boolean).join("\n\n"))){
   const store=useDashboardStore.getState();
   if(store.drafts[submittedKey]===submittedText)store.clearDraft(submittedKey);
   setNotice("");upload.resetLocal();
  }
 };
 return <div className="v3-card-comment-dock">
  <CardComposer text={text} onChangeText={text=>setDraft(draftKey,text)} onSend={()=>void submit()} placeholder={placeholder??t("cards.comment")} label={kind==="comment"?t("cards.sendComment"):t("cards.sendAnswer")} pending={pending} disabled={!ready} focusRequest={focusRequest}
   files={upload.files} onAddFiles={uploadUrl||uploadController?upload.addFiles:undefined} onRemoveFile={upload.removeFile} onAttachUnavailable={()=>setNotice(t("cards.attachmentNeedsSession"))}/>
  {(notice||upload.files.find(file=>file.status==="error")?.errorMessage)?<p role="status" className="v3-card-error">{notice||upload.files.find(file=>file.status==="error")?.errorMessage}</p>:null}
 </div>;
}
