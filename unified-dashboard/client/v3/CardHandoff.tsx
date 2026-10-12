import { useEffect, useRef, useState } from "react";
import { useDashboardStore, appendAttachmentPathNotes, type CatalogFolder } from "@seosoyoung/soul-ui";
import { CardHandoffView } from "./CardHandoffView";
import { useFileUpload } from "@seosoyoung/soul-ui/hooks/useFileUpload";
import { useQueryClient } from "@tanstack/react-query";
import { createDashboardSession } from "../lib/session-create";
import type { CardAssignment } from "@seosoyoung/soul-ui/cards/card-types";
import { FolderPicker } from "./FolderPicker";
import { useFolderPickerStars } from "./use-folder-picker-stars";
import { CardExecutionPickerView, useCardExecutionPicker } from "./CardExecutionPicker";
import { fetchPageSessionDefaults } from "./folder-workspace-page-api";
import "./v3-cards.css";
const storageKey = "cards-p1-handoff";
const draftKey = "composer:main";
function savedSelection(): CardAssignment {
 try { return JSON.parse(localStorage.getItem(storageKey) ?? "null") ?? {folderId:"",nodeId:"",agentId:"",modelPreset:""}; }
 catch { return {folderId:"",nodeId:"",agentId:"",modelPreset:""}; }
}
export function CardHandoff({folders}: {folders: readonly CatalogFolder[]}) {
 const queryClient=useQueryClient();
 const [selection,setSelection] = useState(savedSelection);
 const request = useDashboardStore(s=>s.drafts[draftKey]??"");
 const setDraft = useDashboardStore(s=>s.setDraft);
 const [folderOpen,setFolderOpen] = useState(false),[executionOpen,setExecutionOpen] = useState(false);
 const [pending,setPending] = useState(false),[error,setError] = useState<string|null>(null);
 const [uploadSessionId,setUploadSessionId] = useState(() => crypto.randomUUID());
 const changeId = useRef(0);
 const stars = useFolderPickerStars(folderOpen,folders);
 const {agent,model,valid:modelValid,unavailableMessage,view}=useCardExecutionPicker({
  selection,onChange:next=>{changeId.current++;setSelection(next);},onError:setError,
  disabled:pending,open:executionOpen,onClose:()=>setExecutionOpen(false),
 });
 const fileUploadUrl = selection.nodeId ? `/api/attachments/sessions?nodeId=${encodeURIComponent(selection.nodeId)}` : "";
 const {files,isReady,uploadedPaths,addFiles,removeFile,resetLocal} = useFileUpload({uploadUrl:fileUploadUrl,sessionId:uploadSessionId,folderId:selection.folderId});
 const attachFiles = (incoming:FileList|File[]) => {
  addFiles(incoming);
 };
 const canSubmit = !pending && modelValid && isReady && Boolean(request.trim()&&selection.folderId&&selection.nodeId&&selection.agentId);
 useEffect(() => {localStorage.setItem(storageKey,JSON.stringify(selection));},[selection]);
 const selectFolder = async (folder:CatalogFolder) => {
  const id = ++changeId.current;
  setSelection(s=>({...s,folderId:folder.id}));setFolderOpen(false);setError(null);
  if (!folder.projectPageId) return;
  try {
   const defaults = await fetchPageSessionDefaults(folder.projectPageId);
   if (defaults && id===changeId.current) {
    setSelection(s=>({...s,nodeId:defaults.nodeId??s.nodeId,agentId:defaults.agentId??s.agentId,modelPreset:defaults.modelPreset??s.modelPreset}));
   }
  } catch (e) {setError(String(e));}
 };
 const submit = async () => {
  if (!canSubmit) return;
  const submittedKey = draftKey, submittedText = request;
  setPending(true);setError(null);
  const attachmentPaths = uploadedPaths;
  try {
   await createDashboardSession({queryClient,addOptimisticSession:useDashboardStore.getState().addOptimisticSession,
    initialInstruction:appendAttachmentPathNotes(request.trim(),attachmentPaths),attachmentPaths,
    folderId:selection.folderId,nodeId:selection.nodeId,agentId:selection.agentId,agent,modelPreset:selection.modelPreset||null});
   const store = useDashboardStore.getState();
   if (store.drafts[submittedKey]===submittedText) store.clearDraft(submittedKey);
   resetLocal();setUploadSessionId(crypto.randomUUID());
  } catch (e) {setError(String(e));} finally {setPending(false);}
 };
 const folder = folders.find(f=>f.id===selection.folderId);
 return <CardHandoffView
  composer={{text:request,onChangeText:text=>setDraft(draftKey,text),onSend:()=>void submit(),placeholder:"새 세션에서 무엇을 할까요",inputLabel:"세션 첫 메시지",label:"세션 시작",disabled:!canSubmit,pending,
   files,onAddFiles:fileUploadUrl?attachFiles:undefined,onRemoveFile:removeFile,onAttachUnavailable:()=>setError("첨부하려면 실행 노드를 선택해 주세요.")}}
  folderLabel={folder?`📁 ${folder.name}`:"폴더 선택"}
  executionLabel={<>{agent?.id===selection.agentId ? agent.name : selection.agentId||"에이전트"} · {selection.nodeId||"노드"} · <span className={model?.id===selection.modelPreset && model.reason==="quota_exhausted" ? "text-destructive" : undefined}>{model?.id===selection.modelPreset ? model.label : selection.modelPreset||"모델"}</span></>}
  folderOpen={folderOpen} onFolderOpenChange={setFolderOpen} executionOpen={executionOpen} onExecutionOpenChange={setExecutionOpen} executionInvalid={Boolean(unavailableMessage)}
  error={error||files.find(f=>f.status==="error")?.errorMessage||unavailableMessage}
  folderPicker={<FolderPicker folders={folders} starredFolderIds={stars.folderIds} selectedFolderId={selection.folderId} disabledFolderIds={new Set(["claude","llm"])} pending={pending} onSelect={f=>void selectFolder(f)}/>}
  executionPicker={<CardExecutionPickerView {...view}/>}/>;
}
