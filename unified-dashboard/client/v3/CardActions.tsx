import { useState } from "react";
import { DashboardIconCap } from "@seosoyoung/soul-ui";
import { Check, MessageCircle } from "lucide-react";
import type { CardRow, CardStatus } from "@seosoyoung/soul-ui/cards/card-types";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import { V3ContextMenu, type V3ContextMenuTarget } from "./V3ContextMenu";
const states: readonly {status:CardStatus;label:string;separatorBefore?:boolean}[] = [
 {status:"todo",label:"할 일"},{status:"queued",label:"대기열"},{status:"running",label:"실행 중"},
 {status:"review",label:"검수"},{status:"done",label:"완료",separatorBefore:true},{status:"cancelled",label:"취소",separatorBefore:true},
];
export function CardActions({card,onAnswer}:{card:CardRow;onAnswer():void}) {
 const [pending,setPending]=useState(false);
 const complete=async()=>{setPending(true);try{await useCardStore.getState().mutate(card.id,"/status",{status:"done",expectedVersion:card.version});}catch{}finally{setPending(false);}};
 return <div className="v3-card-actions">{card.status==="review" ? <DashboardIconCap label="완료" disabled={pending} onClick={()=>void complete()}><Check className="h-4 w-4"/></DashboardIconCap>:card.status==="blocked"&&card.blockedKind==="question" ? <DashboardIconCap label="답하기" onClick={onAnswer}><MessageCircle className="h-4 w-4"/></DashboardIconCap>:null}</div>;
}
export function CardStatusChip({card}:{card:CardRow}) {
 const [pending,setPending]=useState(false),[error,setError]=useState<string|null>(null),[menu,setMenu]=useState<V3ContextMenuTarget|null>(null);
 const reportCount=useCardStore(s=>s.details[card.id]?.reports.length);
 const labels={todo:"할 일",queued:"대기",blocked:card.blockedKind==="question"?"질문":card.blockedKind==="limit"?"한도 대기":"막힘",running:"실행 중",review:"검수",done:"완료",cancelled:"취소"};
 const change=async(status:CardStatus)=>{setPending(true);setError(null);try{await useCardStore.getState().mutate(card.id,"/status",{status,expectedVersion:card.version});}catch(e){setError(e instanceof Error ? e.message:String(e));}finally{setPending(false);}};
 return <><button type="button" className={`v3-status-chip v3-card-status-control v3-card-status--${card.status}`} aria-label="카드 상태 변경" aria-haspopup="menu" aria-expanded={menu!==null} disabled={pending} onClick={event=>{
  event.stopPropagation();const rect=event.currentTarget.getBoundingClientRect();setMenu({x:rect.left,y:rect.bottom});setError(null);
  if(reportCount===undefined)void useCardStore.getState().loadCard(card.id).catch(e=>setError(String(e)));
 }}>{labels[card.status]}</button>
 <V3ContextMenu target={menu} onClose={()=>setMenu(null)} actions={states.map(({status,label,separatorBefore})=>({
  label:status===card.status ? `${label} (현재)`:status==="review"&&!reportCount ? "검수 (보고 필요)":label,
  disabled:pending||status===card.status||(status==="review"&&!reportCount)||(card.status==="review"&&status==="running"),separatorBefore,onSelect:()=>void change(status),
 }))}/>{error?<span className="v3-card-error" role="alert">{error}</span>:null}</>;
}
