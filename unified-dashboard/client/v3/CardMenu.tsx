import { useState } from "react";
import { Button, Dialog, DialogPopup, DialogHeader, DialogTitle, DialogFooter, type CatalogFolder } from "@seosoyoung/soul-ui";
import type { CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import { V3ContextMenu } from "./V3ContextMenu";
import { FolderPicker } from "./FolderPicker";
import { useFolderPickerStars } from "./use-folder-picker-stars";
import { AgentNodeAssignmentFields } from "./AgentNodeAssignmentFields";
export function CardMenu({card,folders,target,onClose}:{card:CardRow;folders:readonly CatalogFolder[];target:{x:number;y:number}|null;onClose():void}) {
 const [dialog,setDialog]=useState<"move"|"assignment"|null>(null),[pending,setPending]=useState(false),[error,setError]=useState<string|null>(null);
 const [node,setNode]=useState(card.nodeId??""),[agent,setAgent]=useState(card.assigneeAgentId??""),[model,setModel]=useState(card.modelPreset??"");
 const stars=useFolderPickerStars(dialog==="move",folders);
 const mutate=async(suffix:string,body:object,method="POST")=>{setPending(true);setError(null);try{await useCardStore.getState().mutate(card.id,suffix,{...body,expectedVersion:card.version},method);setDialog(null);}catch(e){setError(String(e));}finally{setPending(false);}};
 return <><V3ContextMenu target={target} onClose={onClose} actions={[{label:"폴더 이동",onSelect:()=>setDialog("move")},{label:"담당·노드·모델 변경",onSelect:()=>{setNode(card.nodeId??"");setAgent(card.assigneeAgentId??"");setModel(card.modelPreset??"");setDialog("assignment");}},{label:"취소",destructive:true,onSelect:()=>void mutate("/status",{status:"cancelled"})}]}/>
  {error&&!dialog?<p role="alert" className="v3-card-error">{error}</p>:null}
  <Dialog open={dialog!==null} onOpenChange={open=>{if(!open)setDialog(null);}}><DialogPopup><DialogHeader><DialogTitle>{dialog==="move"?"카드 폴더 이동":"담당·노드·모델 변경"}</DialogTitle></DialogHeader>
  {dialog==="move"?<FolderPicker folders={folders} starredFolderIds={stars.folderIds} disabledFolderIds={new Set([card.folderId,"claude","llm"])} selectedFolderId={card.folderId} pending={pending} onSelect={f=>void mutate("/move",{folderId:f.id})}/>:<AgentNodeAssignmentFields presentation="session" nodeId={node} agentId={agent} modelPreset={model} onNodeIdChange={setNode} onAgentIdChange={setAgent} onModelPresetChange={setModel} disabled={pending} onError={setError}/>}
  {error?<p role="alert" className="v3-card-error">{error}</p>:null}<DialogFooter variant="bare"><Button variant="outline" onClick={()=>setDialog(null)}>닫기</Button>{dialog==="assignment"?<Button disabled={pending} onClick={()=>void mutate("",{assignee:agent?{kind:"agent",agentId:agent}:null,nodeId:node||null,modelPreset:model||null},"PATCH")}>저장</Button>:null}</DialogFooter>
  </DialogPopup></Dialog>
 </>;
}
