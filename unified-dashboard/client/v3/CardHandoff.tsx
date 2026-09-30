import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useDashboardStore, appendAttachmentPathNotes, DashboardIconCap, Popover, PopoverTrigger, PopoverPopup, type AgentInfo, type ModelPresetAvailability, type CatalogFolder } from "@seosoyoung/soul-ui";
import { Paperclip, X } from "lucide-react";
import { ChatSendButton } from "@seosoyoung/soul-ui/components/chat/ChatInputEditor";
import { useFileUpload } from "@seosoyoung/soul-ui/hooks/useFileUpload";
import { LiquidGlassCard } from "@seosoyoung/soul-ui/components/LiquidGlassCard";
import { useQueryClient } from "@tanstack/react-query";
import { createDashboardSession } from "../lib/session-create";
import type { CardAssignment } from "@seosoyoung/soul-ui/cards/card-types";
import { FolderPicker } from "./FolderPicker";
import { useFolderPickerStars } from "./use-folder-picker-stars";
import { CardExecutionPicker } from "./CardExecutionPicker";
import { fetchPageSessionDefaults } from "./folder-workspace-page-api";
import "./v3-cards.css";
const storageKey = "cards-p1-handoff";
function savedSelection(): CardAssignment {
 try { return JSON.parse(localStorage.getItem(storageKey) ?? "null") ?? {folderId:"",nodeId:"",agentId:"",modelPreset:""}; }
 catch { return {folderId:"",nodeId:"",agentId:"",modelPreset:""}; }
}
export function CardHandoff({folders}: {folders: readonly CatalogFolder[]}) {
 const queryClient=useQueryClient();
 const [modelValid,setModelValid]=useState(true);
 const [selection,setSelection] = useState(savedSelection);
 const [request,setRequest] = useState("");
 const [folderOpen,setFolderOpen] = useState(false),[executionOpen,setExecutionOpen] = useState(false);
 const [pending,setPending] = useState(false),[error,setError] = useState<string|null>(null);
 const [agent,setAgent] = useState<AgentInfo|null>(null),[model,setModel] = useState<ModelPresetAvailability|null>(null);
 const [uploadSessionId,setUploadSessionId] = useState(() => crypto.randomUUID());
 const changeId = useRef(0),textareaRef = useRef<HTMLTextAreaElement>(null),fileInputRef = useRef<HTMLInputElement>(null);
 const stars = useFolderPickerStars(folderOpen,folders);
 const fileUploadUrl = selection.nodeId ? `/api/attachments/sessions?nodeId=${encodeURIComponent(selection.nodeId)}` : "";
 const {files,isUploading,addFiles,removeFile,resetLocal} = useFileUpload({uploadUrl:fileUploadUrl,sessionId:uploadSessionId});
 const attachFiles = (incoming:FileList|File[]) => {
  addFiles(incoming);
 };
 const canSubmit = !pending && modelValid && !isUploading && !files.some(f=>f.status==="error") && Boolean(request.trim()&&selection.folderId&&selection.nodeId&&selection.agentId);
 useLayoutEffect(() => {
  const textarea = textareaRef.current;
  if (!textarea) return;
  const fit = () => {
   textarea.style.height = "auto";
   const line = parseFloat(getComputedStyle(textarea).lineHeight);
   textarea.style.height = `${Math.max(line*3,Math.min(textarea.scrollHeight,line*8))}px`;
  };
  fit();
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(fit) : null;
  observer?.observe(textarea);
  return () => observer?.disconnect();
 },[request]);
 useEffect(() => {localStorage.setItem(storageKey,JSON.stringify(selection));},[selection]);
 const selectFolder = async (folder:CatalogFolder) => {
  const id = ++changeId.current;
  setSelection(s=>({...s,folderId:folder.id}));setFolderOpen(false);setError(null);
  if (!folder.projectPageId) return;
  try {
   const defaults = await fetchPageSessionDefaults(folder.projectPageId);
   if (defaults && id===changeId.current) {
    if (files.length && defaults.nodeId && defaults.nodeId!==selection.nodeId) {
     setError("첨부를 제거한 뒤 노드를 바꿔 주세요.");
     return;
    }
    setSelection(s=>({...s,nodeId:defaults.nodeId??s.nodeId,agentId:defaults.agentId??s.agentId,modelPreset:defaults.modelPreset??s.modelPreset}));
   }
  } catch (e) {setError(String(e));}
 };
 const submit = async () => {
  if (!canSubmit) return;
  setPending(true);setError(null);
  const attachmentPaths = files.flatMap(f=>f.path?[f.path]:[]);
  try {
   await createDashboardSession({queryClient,addOptimisticSession:useDashboardStore.getState().addOptimisticSession,
    initialInstruction:appendAttachmentPathNotes(request.trim(),attachmentPaths),attachmentPaths,
    folderId:selection.folderId,nodeId:selection.nodeId,agentId:selection.agentId,agent,modelPreset:selection.modelPreset||null});
   setRequest("");resetLocal();setUploadSessionId(crypto.randomUUID());
  } catch (e) {setError(String(e));} finally {setPending(false);}
 };
 const folder = folders.find(f=>f.id===selection.folderId);
 return <><form onSubmit={e=>{e.preventDefault();void submit();}}
  onDragOver={e=>{if(fileUploadUrl&&!pending&&e.dataTransfer.types.includes("Files"))e.preventDefault();}}
  onDrop={e=>{if(fileUploadUrl&&!pending&&e.dataTransfer.files.length){e.preventDefault();attachFiles(e.dataTransfer.files);}}}>
  <LiquidGlassCard webglSurface className="v3-card-handoff">
   <textarea ref={textareaRef} rows={3} placeholder="새 세션에서 무엇을 할까요" aria-label="세션 첫 메시지" value={request}
    onChange={e=>setRequest(e.target.value)} disabled={pending}
    onPaste={e=>{if(fileUploadUrl&&!pending&&e.clipboardData.files.length){e.preventDefault();attachFiles(e.clipboardData.files);}}}
    onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();e.currentTarget.form?.requestSubmit();}}}/>
   {files.length ? <div className="v3-card-attachments">{files.map(f=><span key={f.id} className="v3-card-attachment rounded-full" data-upload-status={f.status}>
    <span title={f.file.name}>{f.file.name}{f.status==="uploading"?" · 올리는 중":f.status==="error"?" · 업로드 실패":""}</span>
    <button type="button" aria-label={`${f.file.name} 제거`} disabled={pending} onClick={()=>removeFile(f.id)}><X className="h-4 w-4"/></button>
   </span>)}</div> : null}
   <div className="v3-card-handoff-controls">
    <Popover open={folderOpen} onOpenChange={setFolderOpen}><PopoverTrigger type="button" className="v3-card-handoff-chip v3-card-handoff-folder rounded-full" disabled={pending}>
     <span>{folder ? `📁 ${folder.name}` : "폴더 선택"}</span><span aria-hidden="true">▾</span>
    </PopoverTrigger><PopoverPopup side="top" align="start" sideOffset={8} className="v3-shell v3-card-folder-picker"><FolderPicker folders={folders} starredFolderIds={stars.folderIds} selectedFolderId={selection.folderId} disabledFolderIds={new Set(["claude","llm"])} pending={pending} onSelect={f=>void selectFolder(f)}/></PopoverPopup></Popover>
    <Popover open={executionOpen} onOpenChange={setExecutionOpen}><PopoverTrigger type="button" className="v3-card-handoff-chip v3-card-handoff-execution rounded-full" disabled={pending} aria-label="실행 조합 선택">
     <span>{agent?.id===selection.agentId ? agent.name : selection.agentId||"에이전트"} · {selection.nodeId||"노드"} · {model?.id===selection.modelPreset ? model.label : selection.modelPreset||"모델"}</span><span aria-hidden="true">▾</span>
    </PopoverTrigger><PopoverPopup keepMounted side="top" align="start" sideOffset={8} className="v3-shell v3-card-execution-picker"><CardExecutionPicker selection={selection} onChange={next=>{if(files.length&&next.nodeId!==selection.nodeId){setError("첨부를 제거한 뒤 노드를 바꿔 주세요.");return;}changeId.current++;setSelection(next);}}
     onAgentInfoChange={setAgent} onModelPresetInfoChange={setModel} onValidityChange={setModelValid} disabled={pending} onError={setError}/></PopoverPopup></Popover>
    <div className="v3-card-handoff-send-controls">
     <DashboardIconCap label="첨부" className="v3-card-handoff-attach" disabled={pending||!fileUploadUrl} onClick={()=>fileInputRef.current?.click()}><Paperclip className="h-4 w-4" aria-hidden="true"/></DashboardIconCap>
     <ChatSendButton className="v3-card-handoff-submit" label="세션 시작" onSend={()=>void submit()} disabled={!canSubmit}/>
    </div>
   </div>
   <input type="file" ref={fileInputRef} multiple hidden onChange={e=>{if(e.target.files)attachFiles(e.target.files);e.target.value="";}}/>
  </LiquidGlassCard>
 </form>{error?<p role="alert" className="v3-card-error">{error}</p>:null}</>;
}
