import {useState} from "react";
import {Button} from "@seosoyoung/soul-ui";
import type {UploadedFile,UseFileUploadReturn} from "@seosoyoung/soul-ui/hooks/useFileUpload";
import {CardCreateDialog} from "./CardCreateDialog";
import {reviewFolders} from "./components-review-fixtures";
import {useNodes} from "../hooks/useNodes";
/** The production form itself; save and upload retain sample files only in memory. */
export function CardCreateSample(){
 useNodes();
 const [open,setOpen]=useState(false),[files,setFiles]=useState<UploadedFile[]>([]),[notice,setNotice]=useState("");
 const upload:UseFileUploadReturn={files,isUploading:false,isReady:true,uploadedPaths:files.map(f=>f.path!),
  addFiles:incoming=>setFiles(current=>[...current,...Array.from(incoming).map(file=>({id:crypto.randomUUID(),file,path:`/sample/${file.name}`,status:"done" as const}))]),
  removeFile:id=>setFiles(current=>current.filter(f=>f.id!==id)),resetLocal:()=>setFiles([]),cancel:async()=>setFiles([]),restoreUploadedFiles:setFiles};
 return <><Button variant="outline" onClick={()=>setOpen(true)}>새 카드 작성 검수</Button>{notice?<p>{notice}</p>:null}
 {open?<CardCreateDialog folders={reviewFolders} initialFolderId={reviewFolders[0].id} uploadController={upload} onClose={()=>setOpen(false)}
  onSave={async input=>{setNotice(`“${input.title}” · ${input.attachments.length}개 첨부 · 실행 없이 저장하는 검수 샘플입니다.`);return {id:"sample"};}}/>:null}</>;
}
