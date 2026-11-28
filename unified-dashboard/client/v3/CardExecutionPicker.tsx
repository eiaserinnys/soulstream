import { useTranslation } from "react-i18next";
import { useEffect, useMemo, useRef, useState } from "react";
import { errorText } from "./v3-dashboard-utils";
import { Button, FrameLoading, ProfileAvatar, useAgentPortraitUrlResolver, type AgentInfo } from "@seosoyoung/soul-ui";
import type { CardAssignment } from "@seosoyoung/soul-ui/cards/card-types";
import { useOrchestratorStore } from "../store/orchestrator-store";
import { useNodeModelPresetCatalog, type NodeModelPresetCatalog } from "../lib/use-node-model-preset-catalog";
import {
  noAvailableModelMessage,
  hasNoAvailableModelPreset,
  modelPresetOptionLabel,
  modelPresetSelectionState,
  modelPresetReasonText,
  modelPresetsByAgentBackend,
} from "../lib/model-presets";

// Same node/agents endpoint and preset catalog as SessionSuccessionModal.
export function useCardExecutionPicker({selection,onChange,onError,disabled,open,onClose}: {
 selection:CardAssignment;onChange(selection:CardAssignment):void;
 onError(message:string):void;disabled:boolean;
 open:boolean;onClose():void;
}) {
 const {t,i18n}=useTranslation();
 const nodes=useOrchestratorStore(s=>s.nodes);
 const connected=useMemo(()=>[...nodes.values()].filter(node=>node.status==="connected"),[nodes]);
 const [byNode,setByNode]=useState<Record<string,AgentInfo[]>>({});
 const [draftSelection,setDraftSelection]=useState(selection);
 const errorRef=useRef(onError);errorRef.current=onError;
 useEffect(()=>{
  if(open)setDraftSelection(selection);
 },[open,selection]);
 useEffect(()=>{
  let active=true;
  void Promise.all(connected.map(async node=>{
   const response=await fetch(`/api/nodes/${encodeURIComponent(node.nodeId)}/agents`,{credentials:"same-origin",headers:{Accept:"application/json"}});
   if(!response.ok)throw new Error(t("cards.agentListError",{status:response.status}));
   const payload=await response.json() as {agents:AgentInfo[]};return [node.nodeId,payload.agents] as const;
  })).then(entries=>{if(active)setByNode(Object.fromEntries(entries));}).catch(e=>{if(active)errorRef.current(errorText(e));});
  return ()=>{active=false;};
 },[connected,t]);
 const agents=useMemo(()=>{
  const ordered=[draftSelection.nodeId,...connected.map(node=>node.nodeId).filter(id=>id!==draftSelection.nodeId)];
  return [...new Map(ordered.flatMap(id=>(byNode[id]??[]).map(agent=>[agent.id,{agent,nodeId:id}] as const)).reverse()).values()].reverse();
 },[byNode,connected,draftSelection.nodeId]);
 const selectedAgent=byNode[selection.nodeId]?.find(agent=>agent.id===selection.agentId)??null;
 const catalog=useNodeModelPresetCatalog(selection.nodeId,onError);
 const model=catalog.nodeId===selection.nodeId ? catalog.presets.find(preset=>preset.id===selection.modelPreset)??null:null;
 const draftCatalog=useNodeModelPresetCatalog(draftSelection.nodeId!==selection.nodeId ? draftSelection.nodeId : "",onError);
 const fetchedDraftCatalog=draftSelection.nodeId===selection.nodeId ? catalog : draftCatalog;
 const pickerCatalog:NodeModelPresetCatalog=fetchedDraftCatalog.nodeId===draftSelection.nodeId
  ? fetchedDraftCatalog
  : {nodeId:draftSelection.nodeId,status:draftSelection.nodeId?"loading":"idle",presets:[]};
 const draftAgent=byNode[draftSelection.nodeId]?.find(agent=>agent.id===draftSelection.agentId)??null;
 const draftModel=pickerCatalog.nodeId===draftSelection.nodeId
  ? pickerCatalog.presets.find(preset=>preset.id===draftSelection.modelPreset)??null
  : null;
 const canConfirm=Boolean(draftSelection.nodeId&&draftAgent&&pickerCatalog.nodeId===draftSelection.nodeId
  &&pickerCatalog.status==="ready"&&Boolean(draftSelection.modelPreset)&&draftModel?.available);
 const unavailableMessage=useMemo(()=>{
  if(catalog.nodeId!==selection.nodeId||catalog.status!=="ready"||!selection.modelPreset)return null;
  const selectedPreset=catalog.presets.find(preset=>preset.id===selection.modelPreset);
  if(!selectedPreset)return modelPresetSelectionState(selection.modelPreset,catalog.presets,true,t).warning;
  if(selectedPreset.available)return null;
  const reason=modelPresetReasonText(selectedPreset,t,i18n.language);
  return reason?`${selectedPreset.label} · ${reason}`:selectedPreset.label;
 },[catalog.nodeId,catalog.presets,catalog.status,selection.modelPreset,selection.nodeId,t,i18n.language]);
 const valid=Boolean(selection.nodeId&&selectedAgent&&catalog.nodeId===selection.nodeId
  &&catalog.status==="ready"&&(!selection.modelPreset||model?.available));
 return {
  agent:selectedAgent,model,valid,unavailableMessage,
  view:{selection:draftSelection,onChange:setDraftSelection,onCancel:onClose,
   onConfirm:()=>{if(disabled||!canConfirm)return;onChange(draftSelection);onClose();},
   canConfirm,disabled,connected,agents,byNode,catalog:pickerCatalog},
 };
}

/** Shared picker markup; the review sample supplies a local catalog. */
export function CardExecutionPickerView({selection,onChange,onCancel,onConfirm,canConfirm,disabled,connected,agents,byNode,catalog}: {
 selection:CardAssignment;onChange(selection:CardAssignment):void;onCancel():void;onConfirm():void;canConfirm:boolean;disabled:boolean;
 connected:readonly {nodeId:string}[];agents:readonly {agent:AgentInfo;nodeId:string}[];
 byNode:Record<string,AgentInfo[]>;catalog:NodeModelPresetCatalog;
}) {
 const {t,i18n}=useTranslation();
 const resolvePortrait=useAgentPortraitUrlResolver();
 return <div className="v3-card-execution-body">
  <div className="v3-card-execution-columns">
   <section aria-label={t("cards.agent")}><h3>{t("cards.agent")}</h3>{agents.map(({agent,nodeId})=><button type="button" key={agent.id} aria-pressed={selection.agentId===agent.id} disabled={disabled} onClick={()=>onChange({...selection,agentId:agent.id,nodeId,modelPreset:agent.default_preset??""})}>
    <span className="v3-card-picker-avatar"><ProfileAvatar role="assistant" hasPortrait portraitUrl={agent.portraitUrl||resolvePortrait(agent.id)} fallbackEmoji="🤖"/></span><span>{agent.name}</span></button>)}</section>
   <section aria-label={t("cards.node")}><h3>{t("cards.node")}</h3>{connected.length===0?<p>{t("cards.noConnectedNodes")}</p>:connected.map(node=><button type="button" key={node.nodeId} aria-pressed={selection.nodeId===node.nodeId} disabled={disabled||Boolean(selection.agentId&&!byNode[node.nodeId]?.some(agent=>agent.id===selection.agentId))} onClick={()=>onChange({...selection,nodeId:node.nodeId,modelPreset:""})}>{node.nodeId}</button>)}</section>
   <section aria-label={t("cards.model")}><h3>{t("cards.model")}</h3>{catalog.nodeId===selection.nodeId ? <>
    {hasNoAvailableModelPreset(catalog)?<p>{noAvailableModelMessage(t)}</p>:null}
    {modelPresetsByAgentBackend(catalog.presets,agents.find(({agent})=>agent.id===selection.agentId)?.agent.backend).map(preset=>{
    const reason=modelPresetReasonText(preset,t,i18n.language);
    return <button type="button" key={preset.id} className={reason?"v3-card-execution-option--reason":undefined} aria-pressed={selection.modelPreset===preset.id} disabled={disabled||!preset.available} onClick={()=>onChange({...selection,modelPreset:preset.id})}>
     {reason ? <><span className={preset.reason==="quota_exhausted"?"v3-card-execution-name text-destructive":"v3-card-execution-name"}>{preset.label}</span><span className="v3-card-execution-reason">{reason}</span></>
      : <span>{modelPresetOptionLabel(preset,undefined,true,t,i18n.language)}</span>}
    </button>;
   })}</> : null}{catalog.status==="loading"?<FrameLoading inline label={t("cards.loading")}/>:null}</section>
  </div>
  <div className="v3-card-execution-actions">
   <Button variant="ghost" onClick={onCancel}>{t("cards.cancel")}</Button>
   <Button disabled={disabled||!canConfirm} onClick={onConfirm}>{t("cards.confirm")}</Button>
  </div>
 </div>;
}
