import { useEffect, useRef, useState } from "react";
import type { CardDetail, CardRow, CardStatus } from "@seosoyoung/soul-ui/cards/card-types";

export interface CardStatusControl {
  pending: boolean;
  load(): Promise<CardDetail>;
  change(card: CardRow, status: CardStatus, reason?: string): Promise<unknown>;
}
export const cardStatusChoices = ["todo", "queued", "running", "review", "done", "cancelled"] as const;

/** One client contract for picker, context menu, completion and lane drops. */
export function cardTransitionError(detail:CardDetail, status:CardStatus, reason?:string):string|null {
  if (status==="blocked") return "막힘 단계로 직접 옮길 수 없습니다";
  if (status==="review" && !detail.reports.length) return "보고가 필요합니다";
  if (status==="running" && detail.card.status==="review" && !reason?.trim()) return "다시 실행할 사유가 필요합니다";
  return null;
}
export async function performCardTransition(control:CardStatusControl,status:CardStatus,reason?:string,loaded?:CardDetail) {
  const detail=loaded??await control.load();
  const error=cardTransitionError(detail,status,reason);
  if(error)throw new Error(error);
  if(detail.card.status===status)return;
  await control.change(detail.card,status,reason);
}

export function useCardStatusCoordinator(card:CardRow,control:CardStatusControl) {
  const [open,setOpen]=useState(false),[detail,setDetail]=useState<CardDetail|null>(null);
  const [loading,setLoading]=useState(false),[pending,setPending]=useState(false);
  const [error,setError]=useState(""),[reasonStep,setReasonStep]=useState(false),[draft,setDraft]=useState("");
  const generation=useRef(0),writing=useRef(false);
  useEffect(()=>()=>{generation.current++;},[card.id]);
  const close=()=>{generation.current++;setOpen(false);setDetail(null);setLoading(false);};
  const refresh=async()=>{
    const request=++generation.current;setDetail(null);setError("");setLoading(true);
    try {const latest=await control.load();if(request!==generation.current)return null;
      setDetail(latest);if(latest.card.status!=="review")setReasonStep(false);return latest;
    } catch(failure){if(request===generation.current)setError(failure instanceof Error?failure.message:String(failure));return null;}
    finally {if(request===generation.current)setLoading(false);}
  };
  const commit=async(latest:CardDetail,status:CardStatus,reason?:string)=>{
    if(status===latest.card.status)return;
    const blocked=cardTransitionError(latest,status,reason);
    if(status==="running" && latest.card.status==="review" && !reason?.trim()){
      setReasonStep(true);return;
    }
    if(blocked){setError(blocked);return;}
    setPending(true);const request=generation.current;
    try {await performCardTransition(control,status,reason,latest);
      if(request===generation.current){setDraft("");close();}
    } catch(failure){if(request===generation.current)setError(failure instanceof Error?failure.message:String(failure));}
    finally {setPending(false);}
  };
  const request=async(status?:CardStatus)=>{
    if(writing.current||control.pending)return;
    writing.current=true;setOpen(true);setReasonStep(false);
    try {const latest=await refresh();if(latest&&status)await commit(latest,status);}
    finally {writing.current=false;}
  };
  const changeOpen=(next:boolean)=>{if(next===open)return;if(next)void request();else close();};
  const busy=pending||control.pending;
  const unavailable=!detail||loading||busy||Boolean(error);
  const change=async(status:CardStatus,reason?:string)=>{
    if(unavailable||writing.current||!detail)return;
    writing.current=true;try {await commit(detail,status,reason);}finally{writing.current=false;}
  };
  return {open,changeOpen,request,detail,loading,pending,busy,error,reasonStep,setReasonStep,draft,setDraft,refresh,unavailable,change};
}
