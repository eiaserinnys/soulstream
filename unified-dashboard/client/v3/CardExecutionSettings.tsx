import {useRef,useState} from "react";
import {DashboardIconCap,type CatalogFolder} from "@seosoyoung/soul-ui";
import {Pencil} from "lucide-react";
import type {CardRow} from "@seosoyoung/soul-ui/cards/card-types";
import {saveCardExecutionSettings,type CardExecutionSettings as Settings} from "@seosoyoung/soul-ui/cards/card-execution";
import {useCardStore} from "@seosoyoung/soul-ui/cards/card-store";
import {CardCreateDialog,CardStartRefusedError} from "./CardCreateDialog";
export function CardExecutionSettingsDialog({card,folders,onClose,startAfterSave,onSave,onStart,assignment}:{card:CardRow;folders:readonly CatalogFolder[];onClose():void;startAfterSave?:boolean;onSave?(value:Settings,key:string):Promise<CardRow>;onStart?(card:CardRow):Promise<unknown>;assignment?:import("./AgentNodeAssignmentFields").AssignmentData}){
 const latest=useRef(card);
 return <CardCreateDialog starredFolderIds={assignment?folders.map(f=>f.id):undefined} assignment={assignment} folders={folders} onClose={onClose} executionSettings={{card,startAfterSave,onSave:async(value,key)=>{
   const saved=onSave?await onSave(value,key):(await saveCardExecutionSettings(card.id,latest.current.version,value,key)).card;
   latest.current=saved;
   useCardStore.getState().putCards([saved]);
   useCardStore.getState().markLocalChange(saved.id);
   if(startAfterSave){
    try{await (onStart?onStart(saved):useCardStore.getState().execute(card.id,saved.version));}
    catch(cause){throw new CardStartRefusedError(cause instanceof Error?cause.message:String(cause));}
   }
 }}}/>;
}
export function CardExecutionSettings({card,folders,onSave,assignment}:{card:CardRow;folders:readonly CatalogFolder[];onSave?(value:Settings,key:string):Promise<CardRow>;assignment?:import("./AgentNodeAssignmentFields").AssignmentData}){
 const [editing,setEditing]=useState(false);
 if(card.assigneeSessionId)return null;
 return <><div className="v3-task-default-assignment"><div className="v3-task-default-summary">
  <span className="v3-emoji" aria-hidden="true">👤</span><span className="v3-task-default-values">
   <span>{folders.find(f=>f.id===card.folderId)?.name??card.folderId}</span><span>{card.nodeId??"노드 미지정"}</span><span>{card.assigneeAgentId??"에이전트 미지정"}</span><span>{card.modelPreset??"모델 미지정"}</span>
  </span><DashboardIconCap className="v3-task-default-edit" label="카드 실행 설정 편집" aria-expanded={editing} onClick={()=>setEditing(true)}><Pencil className="h-4 w-4"/></DashboardIconCap>
 </div></div>{editing?<CardExecutionSettingsDialog card={card} folders={folders} onClose={()=>setEditing(false)} onSave={onSave} assignment={assignment}/>:null}</>;
}
