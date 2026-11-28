import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import { errorText } from "./v3-dashboard-utils";
import { useDashboardStore, type CatalogFolder } from "@seosoyoung/soul-ui";
import { appendAttachmentPathNotes } from '../../../packages/wire-schema/src/attachment_path_notes';
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
 const {t,i18n}=useTranslation();
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
  } catch (e) {setError(errorText(e));}
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
  } catch (e) {setError(errorText(e));} finally {setPending(false);}
 };
 const folder = folders.find(f=>f.id===selection.folderId);
 const useCompactCopy = i18n.resolvedLanguage === "ja" || i18n.resolvedLanguage === "zh-Hans";
 const unassigned = !selection.agentId && !selection.nodeId && !selection.modelPreset;
 return <CardHandoffView
  composer={{text:request,onChangeText:text=>setDraft(draftKey,text),onSend:()=>void submit(),placeholder:t("cards.startSessionPlaceholder"),inputLabel:t("cards.firstSessionMessage"),label:t("cards.startSession"),disabled:!canSubmit,pending,
   files,onAddFiles:fileUploadUrl?attachFiles:undefined,onRemoveFile:removeFile,onAttachUnavailable:()=>setError(t("cards.selectNodeToAttach"))}}
  folderLabel={folder?`📁 ${folder.name}`:t(useCompactCopy ? "cards.folder" : "cards.selectFolder")}
  folderButtonLabel={!folder && useCompactCopy ? t("cards.selectFolder") : undefined}
  executionLabel={unassigned && useCompactCopy ? t("cards.executionSettings") : <>{agent?.id===selection.agentId ? agent.name : selection.agentId||t("cards.agent")} · {selection.nodeId||t("cards.node")} · <span className={model?.id===selection.modelPreset && model.reason==="quota_exhausted" ? "text-destructive" : undefined}>{model?.id===selection.modelPreset ? model.label : selection.modelPreset||t("cards.model")}</span></>}
  folderOpen={folderOpen} onFolderOpenChange={setFolderOpen} executionOpen={executionOpen} onExecutionOpenChange={setExecutionOpen} executionInvalid={Boolean(unavailableMessage)}
  error={error||files.find(f=>f.status==="error")?.errorMessage||unavailableMessage}
  folderPicker={<FolderPicker folders={folders} starredFolderIds={stars.folderIds} selectedFolderId={selection.folderId} disabledFolderIds={new Set(["claude","llm"])} pending={pending} onSelect={f=>void selectFolder(f)}/>}
  executionPicker={<CardExecutionPickerView {...view}/>}/>;
}
