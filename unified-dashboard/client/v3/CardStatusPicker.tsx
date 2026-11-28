import type {CardExecutionState} from "@seosoyoung/soul-ui/cards/card-execution-state";
import {cardExecutionState,subscribeCardExecution} from "@seosoyoung/soul-ui/cards/card-execution";
import {CardApiError} from "@seosoyoung/soul-ui/cards/card-api";
import {CardExecutionSettingsDialog} from "./CardExecutionSettings";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useMemo, useImperativeHandle, useSyncExternalStore, type Ref } from "react";
import { Check, MoreHorizontal } from "lucide-react";
import { CARD_COLORS, CARD_COLOR_KEYS, type CardColor } from "../../../packages/wire-schema/src/card_colors";
import { CARD_STATUS_LABELS } from "../../../packages/wire-schema/src/card_status_labels";
import type { CardStatus } from "../../../packages/wire-schema/generated/typescript/index";
import { type CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { Button, DashboardIconCap, FrameLoading, StatusChip, useDashboardStore, Popover, PopoverPopup, PopoverTrigger, AlertDialog, AlertDialogPopup, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter } from "@seosoyoung/soul-ui";
import type { CardQueueStatusActivator } from "@seosoyoung/soul-ui/cards/CardQueue";
import { cardDependencyStatus, cardStatusLabel } from "./CardActions";
import "./v3-card-status-picker.css";

export type { CardStatusControl } from "./card-status-coordinator";
import { cardStatusChoices, useCardStatusCoordinator, type CardStatusControl } from "./card-status-coordinator";
import { useCardBoardLayer } from "./card-board-layer";
export interface CardStatusHandle { request(status?:CardStatus):void; requestColor():void; }

/** The existing status popup hosts all transition entry points. */
export function CardStatusPicker({card,control,onOpen,ref,sampleExecution,activator,trigger="chip"}: {
  card:CardRow;control:CardStatusControl;onOpen():void;ref?:Ref<CardStatusHandle>;sampleExecution?:CardExecutionState;activator?:CardQueueStatusActivator;trigger?:"chip"|"more";
}) {
  const observedExecution=useSyncExternalStore(subscribeCardExecution,()=>cardExecutionState(card.id),()=>undefined);
  const execution=sampleExecution??observedExecution;
  const catalogFolders=useDashboardStore(s=>s.catalog?.folders);
  const folders=control.folders??catalogFolders??[];
  const [settingsCard,setSettingsCard]=useState<CardRow|null>(null);
  const [confirmation,setConfirmation]=useState<{card:CardRow;resolve:(value:boolean)=>void}|null>(null);
  const colorButtonRefs=useRef(new Map<CardColor,HTMLButtonElement>());
  const colorButtonRefCallbacks=useRef(new Map<CardColor,(node:HTMLButtonElement|null)=>void>());
  const pendingColorFocus=useRef(false);
  const previousView=useRef<"status"|"color">("status");
  const state=useCardStatusCoordinator(card,{...control,change:async(latest,status,reason)=>{
    if(status==='running' && latest.dependsOn?.some(dependency=>!dependency.met)) {
      const accepted=await new Promise<boolean>(resolve=>setConfirmation({card:latest,resolve}));
      if(!accepted)return;
    }
    const openSettings=()=>{state.close();setSettingsCard(latest);};
    if(status==='running'&&!latest.assigneeSessionId&&(!latest.nodeId||!latest.assigneeAgentId||!latest.modelPreset)){
      openSettings();return;
    }
    try{return await control.change(latest,status,reason);}
    catch(error){if(status==='running'&&!latest.assigneeSessionId&&error instanceof CardApiError&&error.code==='CARD_EXECUTION_SETTINGS_REQUIRED'){openSettings();return;}throw error;}
  }});
  const {open,view,changeOpen,detail,loading,busy,error,refresh,unavailable,change,changeColor,showColors,showStatuses}=state;
  const currentColor=detail?.card.color??card.color??"yellow";
  const currentStatus=detail?.card.status??card.status;
  const statusOutsideChoices=(cardStatusChoices as readonly CardStatus[]).includes(currentStatus)?null:currentStatus;
  const colorButtonRef=(color:CardColor)=>{
    let callback=colorButtonRefCallbacks.current.get(color);
    if(!callback){callback=node=>{if(node)colorButtonRefs.current.set(color,node);else colorButtonRefs.current.delete(color);};colorButtonRefCallbacks.current.set(color,callback);}
    return callback;
  };
  const initialColorFocus=useCallback(()=>{
    const selected=colorButtonRefs.current.get(currentColor);
    if(selected&&!selected.disabled)return selected;
    return CARD_COLOR_KEYS.map(color=>colorButtonRefs.current.get(color)).find(button=>button&&!button.disabled)??false;
  },[currentColor]);
  useLayoutEffect(()=>{
    const enteringColor=previousView.current!=="color"&&view==="color";
    previousView.current=view;
    if(view!=="color")pendingColorFocus.current=false;
    if(enteringColor)pendingColorFocus.current=true;
    if(!pendingColorFocus.current||!open||view!=="color"||unavailable)return;
    const selected=colorButtonRefs.current.get(currentColor);
    const target=selected&&!selected.disabled?selected:CARD_COLOR_KEYS.map(color=>colorButtonRefs.current.get(color)).find(button=>button&&!button.disabled);
    if(!target||!target.isConnected)return;
    target.focus();pendingColorFocus.current=false;
  },[open,view,detail,loading,unavailable,currentColor]);
  // Base UI's Viewport remeasures content when the active trigger payload changes.
  const popupContent=useMemo(()=>({error,execution,loading,detail,view}),[error,execution,loading,detail,view]);
  const layer=useCardBoardLayer();
  useEffect(()=>{if(open)return layer?.claim();},[layer,open]);
  useImperativeHandle(ref,()=>({request:status=>{void state.request(status);},requestColor:()=>{void state.requestColor();}}));
  useEffect(()=>{activator?.onPopupOpenChange(open);},[activator?.onPopupOpenChange,open]);
  const tone = card.status === "blocked" && card.blockedKind === "question" ? "question" : card.status;
  const answerConfirmation=(value:boolean)=>{confirmation?.resolve(value);setConfirmation(null);};
  return <>{settingsCard?<CardExecutionSettingsDialog card={settingsCard} folders={folders} startAfterSave assignment={control.assignment} onSave={control.saveSettings} onStart={saved=>control.change(saved,"running")} onClose={()=>setSettingsCard(null)}/>:null}
  <AlertDialog open={Boolean(confirmation)} onOpenChange={next=>{if(!next)answerConfirmation(false);}}><AlertDialogPopup>
    <AlertDialogHeader><AlertDialogTitle>선행 카드가 끝나지 않았습니다</AlertDialogTitle><AlertDialogDescription className="v3-card-start-confirm-description">
      {confirmation?.card.dependsOn?.filter(dep=>!dep.met).map(dep=>`${dep.number==null?dep.title:`#${dep.number}`}(${cardDependencyStatus(dep).label})`).join(", ")}이 아직 충족되지 않았습니다. 기다리지 않고 지금 시작할까요?
    </AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><Button variant="outline" onClick={()=>answerConfirmation(false)}>취소</Button><Button onClick={()=>answerConfirmation(true)}>지금 시작</Button></AlertDialogFooter>
  </AlertDialogPopup></AlertDialog><Popover open={open&&!confirmation} onOpenChange={(next,details)=>{
    if(details.reason==="escape-key")details.event.preventDefault();
    changeOpen(next);
  }}>
    <PopoverTrigger ref={activator?.setActivatorNodeRef} {...activator?.attributes} {...activator?.listeners}
      render={trigger==="more"?<DashboardIconCap size="small" label="상태 변경 메뉴"><MoreHorizontal className="h-4 w-4" aria-hidden="true"/></DashboardIconCap>:undefined}
      payload={popupContent}
      {...(trigger==="chip"?{className:"v3-postit-status-trigger","aria-label":"카드 상태 변경"}:{})}
      aria-disabled={control.pending||activator?.disabled||false}
      disabled={control.pending||activator?.disabled||false} style={activator?{touchAction:"none"}:undefined}
      onClick={event => event.stopPropagation()}
      >
      {trigger==="chip"?<StatusChip label={execution?.phase==="pending"?"시작 중…":cardStatusLabel(card)} tone={tone}/>:null}
    </PopoverTrigger>
    <PopoverPopup align={trigger==="more"?"end":"start"} className="v3-surface v3-card-status-picker glass-strong glass-chrome min-w-32 max-w-(--available-width)" data-card-status-picker onClick={event => event.stopPropagation()} initialFocus={view==="color"?initialColorFocus:undefined}>
      <div className="v3-card-status-picker-content">
        {execution && execution.phase!=='pending'?<><p data-v3-selectable-content="true" role={execution.phase==='error'?'alert':'status'}>{execution.message}</p><Button size="sm" variant="ghost" disabled={busy} onClick={()=>void state.request('running')}>{execution.phase==='delayed'?'다시 확인':'다시 시도'}</Button></>:null}
        {loading ? <FrameLoading inline label="불러오는 중…" /> : null}
        {error ? <><p data-v3-selectable-content="true" role={error.startsWith("실행 결과")?"status":"alert"}>{error}</p><Button size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>{detail ? "갱신 후 재시도" : "다시 불러오기"}</Button></> : null}
        {view==="status"?<>
          {statusOutsideChoices?<p data-v3-selectable-content="true">지금 상태는 {CARD_STATUS_LABELS[statusOutsideChoices]}입니다. 담당이 정한 시각에 다시 확인하며, 아래에서 다른 상태로 바꿀 수 있습니다.</p>:null}
          <div aria-label="카드 상태 목록">{cardStatusChoices.map(status => <Button key={status} variant="menu"
            aria-pressed={status === (detail?.card.status ?? card.status)} disabled={unavailable}
            onClick={() => void change(status)}>{cardStatusLabel({...card, status,blockedKind:null,blockedDetail:null})}</Button>)}</div>
          {control.changeColor?<Button variant="menu" aria-pressed="false" disabled={unavailable} onClick={showColors}>
            카드 색상: {CARD_COLORS[detail?.card.color??card.color??"yellow"].name}
          </Button>:null}
        </>:<>
          <div aria-label="카드 색상 목록">{CARD_COLOR_KEYS.map(color=>{
            const selected=color===currentColor;
            return <Button key={color} ref={colorButtonRef(color)} variant="menu"
              aria-pressed={selected} disabled={unavailable}
              onClick={()=>void changeColor(color)}>
              <span className="inline-flex size-4 shrink-0 items-center justify-center">{selected?<Check className="size-4" aria-hidden="true"/>:null}</span>
              <span>{CARD_COLORS[color].name}</span>
            </Button>;
          })}</div>
          <Button variant="ghost" disabled={busy} onClick={showStatuses}>돌아가기</Button>
        </>}
      </div>
    </PopoverPopup>
  </Popover></>;
}
