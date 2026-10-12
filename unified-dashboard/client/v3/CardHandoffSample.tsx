import { useEffect, useState } from "react";
import { Button, type AgentInfo } from "@seosoyoung/soul-ui";
import type { UploadedFile } from "@seosoyoung/soul-ui/hooks/useFileUpload";
import type { CardAssignment } from "@seosoyoung/soul-ui/cards/card-types";
import type { NodeModelPresetCatalog } from "../lib/use-node-model-preset-catalog";
import { modelPresetUnavailableReason } from "../lib/model-presets";
import { CardHandoffView } from "./CardHandoffView";
import { CardExecutionPickerView } from "./CardExecutionPicker";
import { FolderPicker } from "./FolderPicker";
import { reviewFolders, reviewSession, reviewTitle } from "./components-review-fixtures";

const nodeId=reviewSession.nodeId!;
const agents:AgentInfo[]=[
 {id:reviewSession.agentId!,name:reviewSession.agentName!,portraitUrl:reviewSession.agentPortraitUrl,default_preset:"sol"},
 {id:"components-long-agent",name:reviewTitle,portraitUrl:reviewSession.agentPortraitUrl,default_preset:"sol"},
];
const catalog:NodeModelPresetCatalog={nodeId,status:"ready",presets:[
 {id:"sol",label:"Sol",backend:"codex",available:true,reason:null,reason_label:null,resets_at:null,usage_warning:false},
 {id:"exhausted-sol",label:"Sol (사용량 소진 예시)",backend:"codex",available:true,reason:"quota_exhausted",reason_label:"7일 사용량 제한",resets_at:null,usage_warning:false},
 {id:"rejected-opus",label:"Claude - Opus",backend:"claude",available:false,reason:"limit_rejected",reason_label:"5시간 한도 거부 중",resets_at:"2030-01-02T03:04:00.000Z",usage_warning:false},
 {id:"rejected-weekly-fable",label:"Claude - Fable",backend:"claude",available:false,reason:"limit_rejected",reason_label:"7일 한도 거부 중",resets_at:"2030-01-02T03:04:00.000Z",usage_warning:false},
 {id:"unavailable-astra",label:"Codex - 6 Astra",backend:"codex",available:false,reason:"not_authenticated",reason_label:"미인증",resets_at:null,usage_warning:false},
]};

/** Actual handoff/picker layout with local callbacks and no operational writes. */
export function CardHandoffSample({onSend}:{onSend(text:string):void}) {
 const [text,setText]=useState("");
 const [files,setFiles]=useState<UploadedFile[]>([]);
 const [scenario,setScenario]=useState<"default"|"rejected">("default");
 const [selection,setSelection]=useState<CardAssignment>({folderId:reviewFolders[0].id,nodeId,agentId:agents[0].id,modelPreset:"sol"});
 const [draftSelection,setDraftSelection]=useState(selection);
 const [folderOpen,setFolderOpen]=useState(false),[executionOpen,setExecutionOpen]=useState(false);
 const folder=reviewFolders.find(folder=>folder.id===selection.folderId)!;
 const agent=agents.find(agent=>agent.id===selection.agentId)!;
 const model=catalog.presets.find(preset=>preset.id===selection.modelPreset);
 const modelReason=model&&!model.available?modelPresetUnavailableReason(model):null;
 const unavailableMessage=model&&!model.available?`${model.label}${modelReason?` · ${modelReason}`:""}`:null;
 const draftModel=catalog.presets.find(preset=>preset.id===draftSelection.modelPreset);
 const canConfirm=Boolean(draftSelection.nodeId&&agents.some(candidate=>candidate.id===draftSelection.agentId)
  &&catalog.nodeId===draftSelection.nodeId&&catalog.status==="ready"&&(!draftSelection.modelPreset||draftModel?.available));
 useEffect(()=>{if(executionOpen)setDraftSelection(selection);},[executionOpen,selection]);
 const chooseScenario=(next:"default"|"rejected")=>{
  setScenario(next);
  setSelection(current=>({...current,modelPreset:next==="rejected"?"rejected-opus":"sol"}));
 };
 return <div data-testid="card-handoff-review-sample" className="space-y-2">
  <div role="group" aria-label="검수 상태" className="flex items-center gap-2">
   <Button size="sm" variant="ghost" aria-pressed={scenario==="default"} onClick={()=>chooseScenario("default")}>기본</Button>
   <Button size="sm" variant="ghost" aria-pressed={scenario==="rejected"} onClick={()=>chooseScenario("rejected")}>저장 모델 거부 중</Button>
  </div>
  <CardHandoffView
   composer={{text,onChangeText:setText,onSend:()=>{if(text.trim()){onSend(text);setText("");setFiles([]);}},placeholder:"샘플 메시지",inputLabel:"검수 메시지",label:"샘플 전송",disabled:!text.trim(),pending:false,files,
    onAddFiles:incoming=>setFiles(current=>[...current,...Array.from(incoming).map(file=>({id:crypto.randomUUID(),file,path:null,status:"done" as const}))]),
    onRemoveFile:id=>setFiles(current=>current.filter(file=>file.id!==id))}}
   folderLabel={`📁 ${folder.name}`} executionLabel={<>{agent.name} · {selection.nodeId} · <span className={model?.reason==="quota_exhausted" ? "text-destructive" : undefined}>{model?.label}</span></>} folderButtonLabel="샘플 폴더 선택"
   folderOpen={folderOpen} onFolderOpenChange={setFolderOpen} executionOpen={executionOpen} onExecutionOpenChange={setExecutionOpen} executionInvalid={Boolean(unavailableMessage)} error={unavailableMessage}
   folderPicker={<FolderPicker folders={reviewFolders} starredFolderIds={reviewFolders.map(folder=>folder.id)} selectedFolderId={selection.folderId} disabledFolderIds={new Set()} pending={false}
    onSelect={folder=>{setSelection(current=>({...current,folderId:folder.id}));setFolderOpen(false);}}/>}
   executionPicker={<CardExecutionPickerView selection={draftSelection} onChange={setDraftSelection} onCancel={()=>setExecutionOpen(false)}
    onConfirm={()=>{if(canConfirm){setSelection(draftSelection);setExecutionOpen(false);}}} canConfirm={canConfirm} disabled={false}
    connected={[{nodeId}]} agents={agents.map(agent=>({agent,nodeId}))} byNode={{[nodeId]:agents}} catalog={catalog}/>}/>
 </div>;
}
