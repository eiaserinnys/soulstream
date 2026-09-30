import { useEffect, useRef, useState } from "react";
import { Button, Input, Popover, PopoverTrigger, PopoverPopup, type CatalogFolder } from "@seosoyoung/soul-ui";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import { createCardInput, cardMutationKey } from "@seosoyoung/soul-ui/cards/card-api";
import type { CardAssignment } from "@seosoyoung/soul-ui/cards/card-types";
import { FolderPicker } from "./FolderPicker";
import { useFolderPickerStars } from "./use-folder-picker-stars";
import { AgentNodeAssignmentFields } from "./AgentNodeAssignmentFields";
import { fetchPageSessionDefaults } from "./folder-workspace-page-api";
const storageKey="cards-p1-handoff";
function savedSelection():CardAssignment {try {return JSON.parse(localStorage.getItem(storageKey)??"null")??{folderId:"",nodeId:"",agentId:"",modelPreset:""};}catch{return {folderId:"",nodeId:"",agentId:"",modelPreset:""};}}
export function CardHandoff({folders}:{folders:readonly CatalogFolder[]}) {
 const [selection,setSelection]=useState(savedSelection),[request,setRequest]=useState(""),[open,setOpen]=useState(false),[pending,setPending]=useState(false),[error,setError]=useState<string|null>(null);
 const changeId=useRef(0);const stars=useFolderPickerStars(open,folders);
 useEffect(()=>{localStorage.setItem(storageKey,JSON.stringify(selection));},[selection]);
 const selectFolder=async(folder:CatalogFolder)=>{const id=++changeId.current;setSelection(s=>({...s,folderId:folder.id}));setOpen(false);setError(null);if(!folder.projectPageId)return;try{const defaults=await fetchPageSessionDefaults(folder.projectPageId);if(defaults&&id===changeId.current)setSelection(s=>({...s,nodeId:defaults.nodeId??s.nodeId,agentId:defaults.agentId??s.agentId,modelPreset:defaults.modelPreset??s.modelPreset}));}catch(e){setError(String(e));}};
 return <><form className="v3-card-handoff" onSubmit={e=>{e.preventDefault();if(pending||!request.trim())return;setPending(true);setError(null);void useCardStore.getState().create(createCardInput(request,selection,cardMutationKey())).then(()=>setRequest("")).catch(e=>setError(String(e))).finally(()=>setPending(false));}}>
  <Input placeholder="무엇을 맡길까요" aria-label="무엇을 맡길까요" value={request} onChange={e=>setRequest(e.target.value)} disabled={pending}/>
  <Popover open={open} onOpenChange={setOpen}><PopoverTrigger className="v3-button v3-card-handoff-folder" disabled={pending}>{folders.find(f=>f.id===selection.folderId)?.name??"폴더 선택"}</PopoverTrigger><PopoverPopup className="v3-shell v3-card-folder-picker"><FolderPicker folders={folders} starredFolderIds={stars.folderIds} selectedFolderId={selection.folderId} disabledFolderIds={new Set(["claude","llm"])} pending={pending} onSelect={f=>void selectFolder(f)}/></PopoverPopup></Popover>
  <AgentNodeAssignmentFields presentation="session" layout="compact-row" nodeId={selection.nodeId} agentId={selection.agentId} modelPreset={selection.modelPreset} onNodeIdChange={nodeId=>{changeId.current++;setSelection(s=>({...s,nodeId,agentId:"",modelPreset:""}));}} onAgentIdChange={agentId=>setSelection(s=>({...s,agentId}))} onModelPresetChange={modelPreset=>setSelection(s=>({...s,modelPreset}))} disabled={pending} onError={setError}/>
  <Button type="submit" disabled={pending||!request.trim()||!selection.folderId||!selection.nodeId||!selection.agentId}>맡기기</Button>
 </form>{error?<p role="alert" className="v3-card-error">{error}</p>:null}</>;
}
