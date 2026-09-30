import { useState } from "react";
import { Button, DashboardIconCap, Dialog, DialogPopup, DialogHeader, DialogTitle, DialogFooter, Input } from "@seosoyoung/soul-ui";
import { Check, MessageCircle, Play, RotateCcw, X } from "lucide-react";
import type { CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
export function CardActions({card,onAnswer}:{card:CardRow;onAnswer():void}) {
  const [reject,setReject]=useState(false),[reason,setReason]=useState(""),[pending,setPending]=useState(false),[error,setError]=useState<string|null>(null);
  const change=async(status:string,reason?:string)=>{
    setPending(true);setError(null);
    try{await useCardStore.getState().mutate(card.id,"/status",{status,expectedVersion:card.version,...(reason?{reason}: {})});setReject(false);}
    catch(error){setError(error instanceof Error?error.message:String(error));}finally{setPending(false);}
  };
  const action=(label:string,Icon:typeof Check,onClick:()=>void)=><DashboardIconCap key={label} label={label} disabled={pending} onClick={onClick}><Icon className="h-4 w-4" aria-hidden="true"/></DashboardIconCap>;
  return <div className="v3-card-actions">
    {card.status==="review"?<>{action("완료",Check,()=>void change("done"))}{action("반려",RotateCcw,()=>setReject(true))}</>:null}
    {card.status==="blocked" ? card.blockedKind==="question"?action("답하기",MessageCircle,onAnswer):action("대기열로",Play,()=>void change("queued")):null}
    {card.status==="todo"?action("맡기기",Play,()=>void change("queued")):null}
    {card.status==="queued"?action("대기열에서 빼기",X,()=>void change("todo")):null}
    {error?<span className="v3-card-error" role="alert">{error}</span>:null}
    <Dialog open={reject} onOpenChange={setReject}><DialogPopup><DialogHeader><DialogTitle>반려 사유</DialogTitle></DialogHeader>
      <Input aria-label="반려 사유" value={reason} onChange={e=>setReason(e.target.value)} />
      <DialogFooter variant="bare"><Button variant="outline" onClick={()=>setReject(false)}>취소</Button><Button disabled={pending||!reason.trim()} onClick={()=>void change("running",reason.trim())}>반려</Button></DialogFooter>
    </DialogPopup></Dialog>
  </div>;
}
export function CardStatusChip({card}:{card:Pick<CardRow,"status"|"blockedKind">}) {
  const labels={todo:"할 일",queued:"대기",blocked:card.blockedKind==="question"?"질문":card.blockedKind==="limit"?"한도 대기":"막힘",running:"실행 중",review:"검수",done:"완료",cancelled:"취소"};
  return <span className={`v3-status-chip v3-card-status--${card.status}`}>{labels[card.status]}</span>;
}
