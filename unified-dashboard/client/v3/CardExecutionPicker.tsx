import { useEffect, useMemo, useRef, useState } from "react";
import { ProfileAvatar, type AgentInfo, type ModelPresetAvailability } from "@seosoyoung/soul-ui";
import type { CardAssignment } from "@seosoyoung/soul-ui/cards/card-types";
import { useOrchestratorStore } from "../store/orchestrator-store";
import { useNodeModelPresetCatalog, type NodeModelPresetCatalog } from "../lib/use-node-model-preset-catalog";
import { modelPresetOptionLabel } from "../lib/model-presets";

// Same node/agents endpoint and preset catalog as SessionSuccessionModal.
export function CardExecutionPicker({selection,onChange,onAgentInfoChange,onModelPresetInfoChange,onValidityChange,onError,disabled}: {
 selection:CardAssignment;onChange(selection:CardAssignment):void;
 onAgentInfoChange(agent:AgentInfo|null):void;onModelPresetInfoChange(model:ModelPresetAvailability|null):void;
 onValidityChange(valid:boolean):void;onError(message:string):void;disabled:boolean;
}) {
 const nodes=useOrchestratorStore(s=>s.nodes);
 const connected=useMemo(()=>[...nodes.values()].filter(node=>node.status==="connected"),[nodes]);
 const [byNode,setByNode]=useState<Record<string,AgentInfo[]>>({});
 const errorRef=useRef(onError);errorRef.current=onError;
 useEffect(()=>{
  let active=true;
  void Promise.all(connected.map(async node=>{
   const response=await fetch(`/api/nodes/${encodeURIComponent(node.nodeId)}/agents`,{credentials:"same-origin",headers:{Accept:"application/json"}});
   if(!response.ok)throw new Error(`에이전트 목록을 불러오지 못했습니다 (${response.status})`);
   const payload=await response.json() as {agents:AgentInfo[]};return [node.nodeId,payload.agents] as const;
  })).then(entries=>{if(active)setByNode(Object.fromEntries(entries));}).catch(e=>{if(active)errorRef.current(String(e));});
  return ()=>{active=false;};
 },[connected]);
 const agents=useMemo(()=>{
  const ordered=[selection.nodeId,...connected.map(node=>node.nodeId).filter(id=>id!==selection.nodeId)];
  return [...new Map(ordered.flatMap(id=>(byNode[id]??[]).map(agent=>[agent.id,{agent,nodeId:id}] as const)).reverse()).values()].reverse();
 },[byNode,connected,selection.nodeId]);
 const selectedAgent=byNode[selection.nodeId]?.find(agent=>agent.id===selection.agentId)??null;
 const catalog=useNodeModelPresetCatalog(selection.nodeId,onError);
 const model=catalog.nodeId===selection.nodeId ? catalog.presets.find(preset=>preset.id===selection.modelPreset)??null:null;
 useEffect(()=>onAgentInfoChange(selectedAgent),[selectedAgent,onAgentInfoChange]);
 useEffect(()=>onModelPresetInfoChange(model),[model,onModelPresetInfoChange]);
 useEffect(()=>onValidityChange(Boolean(selection.nodeId&&selectedAgent&&catalog.nodeId===selection.nodeId&&catalog.status==="ready"&&(!selection.modelPreset||model?.available))),[catalog.nodeId,catalog.status,model,selection.modelPreset,selection.nodeId,selectedAgent,onValidityChange]);
 return <CardExecutionPickerView selection={selection} onChange={onChange} disabled={disabled} connected={connected} agents={agents} byNode={byNode} catalog={catalog}/>;
}

/** Shared picker markup; the review sample supplies a local catalog. */
export function CardExecutionPickerView({selection,onChange,disabled,connected,agents,byNode,catalog}: {
 selection:CardAssignment;onChange(selection:CardAssignment):void;disabled:boolean;
 connected:readonly {nodeId:string}[];agents:readonly {agent:AgentInfo;nodeId:string}[];
 byNode:Record<string,AgentInfo[]>;catalog:NodeModelPresetCatalog;
}) {
 return <div className="v3-card-execution-columns">
  <section aria-label="에이전트"><h3>에이전트</h3>{agents.map(({agent,nodeId})=><button type="button" key={agent.id} aria-pressed={selection.agentId===agent.id} disabled={disabled} onClick={()=>onChange({...selection,agentId:agent.id,nodeId,modelPreset:agent.default_preset??""})}>
   <span className="v3-card-picker-avatar"><ProfileAvatar role="assistant" hasPortrait portraitUrl={agent.portraitUrl??`/api/nodes/${encodeURIComponent(nodeId)}/agents/${encodeURIComponent(agent.id)}/portrait`} fallbackEmoji="🤖"/></span><span>{agent.name}</span></button>)}</section>
  <section aria-label="노드"><h3>노드</h3>{connected.map(node=><button type="button" key={node.nodeId} aria-pressed={selection.nodeId===node.nodeId} disabled={disabled||Boolean(selection.agentId&&!byNode[node.nodeId]?.some(agent=>agent.id===selection.agentId))} onClick={()=>onChange({...selection,nodeId:node.nodeId,modelPreset:""})}>{node.nodeId}</button>)}</section>
  <section aria-label="모델"><h3>모델</h3>{catalog.nodeId===selection.nodeId ? catalog.presets.map(preset=><button type="button" key={preset.id} aria-pressed={selection.modelPreset===preset.id} disabled={disabled||!preset.available} onClick={()=>onChange({...selection,modelPreset:preset.id})}>{modelPresetOptionLabel(preset)}</button>):null}{catalog.status==="loading"?<p>불러오는 중…</p>:null}</section>
 </div>;
}
