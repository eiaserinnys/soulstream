import { useEffect, useImperativeHandle, type Ref } from "react";
import { Button, Popover, PopoverPopup, PopoverTrigger } from "@seosoyoung/soul-ui";
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
export function CardStatusPicker({card,control,onOpen,ref,onBusyChange}: {
  card:CardRow;control:CardStatusControl;onOpen():void;ref?:Ref<CardStatusHandle>;onBusyChange?(busy:boolean):void;
}) {
  const state=useCardStatusCoordinator(card,control);
  const {open,changeOpen,detail,loading,busy,error,refresh,unavailable,change}=state;
  const layer=useCardBoardLayer();
  useEffect(()=>{if(open)return layer?.claim();},[layer,open]);
  useImperativeHandle(ref,()=>({request:status=>{void state.request(status);}}));
  const board=useCardBoardTransitions();
  useEffect(()=>board?.register(card.id,status=>{void state.request(status);}),[board,card.id,state.request]);
  useEffect(()=>{onBusyChange?.(busy||loading);},[busy,loading,onBusyChange]);
  const tone = card.status === "blocked" && card.blockedKind === "question" ? "question" : card.status;
  return <Popover open={open} onOpenChange={(next,details)=>{
    if(details.reason==="escape-key")details.event.preventDefault();
    changeOpen(next);
  }}>
    <PopoverTrigger className="v3-postit-status-trigger" aria-label="카드 상태 변경" disabled={control.pending}
      onClick={event => event.stopPropagation()}>
      <StatusChip label={cardStatusLabel(card)} tone={tone}/>
    </PopoverTrigger>
    <PopoverPopup align="end" className="v3-card-status-picker" data-card-status-picker onClick={event => event.stopPropagation()}>
      <div className="v3-card-status-picker-content">
        {loading ? <p role="status">불러오는 중…</p> : null}
        {error ? <><p role="alert">{error}</p><Button size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>{detail ? "갱신 후 재시도" : "다시 불러오기"}</Button></> : null}
        <div aria-label="카드 상태 목록">{cardStatusChoices.map(status => <Button key={status} variant="menu"
          aria-pressed={status === (detail?.card.status ?? card.status)} disabled={unavailable}
          onClick={() => void change(status)}>{cardStatusLabel({...card, status,blockedKind:null,blockedDetail:null})}</Button>)}</div>
      </div>
    </PopoverPopup>
  </Popover>;
}
