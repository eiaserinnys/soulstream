import {cardExecutionState,subscribeCardExecution,type CardExecutionState} from "@seosoyoung/soul-ui/cards/card-execution";
import {CardApiError} from "@seosoyoung/soul-ui/cards/card-api";
import {CardExecutionSettingsDialog} from "./CardExecutionSettings";
import { useEffect, useState, useImperativeHandle, useSyncExternalStore, type Ref } from "react";
import { Button, useDashboardStore, Popover, PopoverPopup, PopoverTrigger } from "@seosoyoung/soul-ui";
import type { CardRow, CardStatus } from "@seosoyoung/soul-ui/cards/card-types";
import { cardStatusLabel } from "./CardActions";
import { StatusChip } from "./StatusChip";
import "./v3-card-status-picker.css";

export type { CardStatusControl } from "./card-status-coordinator";
import { cardStatusChoices, useCardStatusCoordinator, type CardStatusControl } from "./card-status-coordinator";
import { useCardBoardTransitions } from "./card-board-transitions";
import { useCardBoardLayer } from "./card-board-layer";
export interface CardStatusHandle { request(status?:CardStatus):void; }

/** The existing status popup hosts all transition entry points. */
export function CardStatusPicker({card,control,onOpen,ref,onBusyChange,sampleExecution}: {
  card:CardRow;control:CardStatusControl;onOpen():void;ref?:Ref<CardStatusHandle>;onBusyChange?(busy:boolean):void;sampleExecution?:CardExecutionState;
}) {
  const observedExecution=useSyncExternalStore(subscribeCardExecution,()=>cardExecutionState(card.id),()=>undefined);
  const execution=sampleExecution??observedExecution;
  const catalogFolders=useDashboardStore(s=>s.catalog?.folders);
  const folders=control.folders??catalogFolders??[];
  const [settingsCard,setSettingsCard]=useState<CardRow|null>(null);
  const state=useCardStatusCoordinator(card,{...control,change:async(latest,status,reason)=>{
    if(status==='running'&&!latest.assigneeSessionId&&(!latest.nodeId||!latest.assigneeAgentId||!latest.modelPreset)){
      setSettingsCard(latest);return;
    }
    try{return await control.change(latest,status,reason);}
    catch(error){if(status==='running'&&!latest.assigneeSessionId&&error instanceof CardApiError&&error.code==='CARD_EXECUTION_SETTINGS_REQUIRED'){setSettingsCard(latest);return;}throw error;}
  }});
  const {open,changeOpen,detail,loading,busy,error,refresh,unavailable,change}=state;
  const layer=useCardBoardLayer();
  useEffect(()=>{if(open)return layer?.claim();},[layer,open]);
  useImperativeHandle(ref,()=>({request:status=>{void state.request(status);}}));
  const board=useCardBoardTransitions();
  useEffect(()=>board?.register(card.id,status=>{void state.request(status);}),[board,card.id,state.request]);
  useEffect(()=>{onBusyChange?.(busy||loading);},[busy,loading,onBusyChange]);
  const tone = card.status === "blocked" && card.blockedKind === "question" ? "question" : card.status;
  return <>{settingsCard?<CardExecutionSettingsDialog card={settingsCard} folders={folders} startAfterSave assignment={control.assignment} onSave={control.saveSettings} onStart={saved=>control.change(saved,"running")} onClose={()=>setSettingsCard(null)}/>:null}<Popover open={open} onOpenChange={(next,details)=>{
    if(details.reason==="escape-key")details.event.preventDefault();
    changeOpen(next);
  }}>
    <PopoverTrigger className="v3-postit-status-trigger" aria-label="카드 상태 변경" disabled={control.pending}
      onClick={event => event.stopPropagation()}>
      <StatusChip label={execution?.phase==="pending"?"시작 중…":cardStatusLabel(card)} tone={tone}/>
    </PopoverTrigger>
    <PopoverPopup align="end" className="v3-card-status-picker" data-card-status-picker onClick={event => event.stopPropagation()}>
      <div className="v3-card-status-picker-content">
        {execution && execution.phase!=='pending'?<><p role={execution.phase==='error'?'alert':'status'}>{execution.message}</p><Button size="sm" variant="ghost" disabled={busy} onClick={()=>void state.request('running')}>{execution.phase==='delayed'?'다시 확인':'다시 시도'}</Button></>:null}
        {loading ? <p role="status">불러오는 중…</p> : null}
        {error ? <><p role={error.startsWith("실행 결과")?"status":"alert"}>{error}</p><Button size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>{detail ? "갱신 후 재시도" : "다시 불러오기"}</Button></> : null}
        <div aria-label="카드 상태 목록">{cardStatusChoices.map(status => <Button key={status} variant="menu"
          aria-pressed={status === (detail?.card.status ?? card.status)} disabled={unavailable}
          onClick={() => void change(status)}>{cardStatusLabel({...card, status,blockedKind:null,blockedDetail:null})}</Button>)}</div>
      </div>
    </PopoverPopup>
  </Popover></>;
}
