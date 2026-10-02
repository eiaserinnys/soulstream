import { useState } from "react";
import { useFileUpload } from "@seosoyoung/soul-ui/hooks/useFileUpload";
import { CardComposer } from "./CardComposer";

export function CardCommentInput({nodeId,sessionId,pending,onSend}:{nodeId?:string|null;sessionId?:string|null;pending:boolean;onSend(body:string):Promise<boolean>}) {
 const [text,setText]=useState(""),[notice,setNotice]=useState("");
 const uploadUrl=nodeId&&sessionId?`/api/attachments/sessions?nodeId=${encodeURIComponent(nodeId)}`:"";
 const upload=useFileUpload({uploadUrl,sessionId:sessionId??""});
 const ready=!pending&&!upload.isUploading&&!upload.files.some(file=>file.status==="error")&&Boolean(text.trim()||upload.files.length);
 const submit=async()=>{
  if(!ready)return;
  const attachments=upload.files.flatMap(file=>{
   if(!file.path)return [];
   const url=`/api/attachments/files?nodeId=${encodeURIComponent(nodeId!)}&path=${encodeURIComponent(file.path)}`;
   const label=file.file.name.replace(/[\[\]\\]/g,"\\$&");
   return [`${file.file.type.startsWith("image/")?"!":""}[${label}](${url})`];
  });
  if(await onSend([text.trim(),...attachments].filter(Boolean).join("\n\n"))){setText("");setNotice("");upload.resetLocal();}
 };
 return <div className="v3-card-comment-dock">
  <CardComposer text={text} onChangeText={setText} onSend={()=>void submit()} placeholder="커멘트" label="커멘트 전송" pending={pending} disabled={!ready}
   files={upload.files} onAddFiles={uploadUrl?upload.addFiles:undefined} onRemoveFile={upload.removeFile} onAttachUnavailable={()=>setNotice("첨부는 곧 지원합니다. 담당 세션이 연결되면 사용할 수 있습니다.")}/>
  {(notice||upload.files.find(file=>file.status==="error")?.errorMessage)?<p role="status" className="v3-card-error">{notice||upload.files.find(file=>file.status==="error")?.errorMessage}</p>:null}
 </div>;
}
