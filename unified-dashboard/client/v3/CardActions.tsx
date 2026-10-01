import { useState } from "react";
import { DashboardIconCap } from "@seosoyoung/soul-ui";
import { Check } from "lucide-react";
import type { CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";

export function CardActions({card}:{card:CardRow}) {
 const [pending,setPending]=useState(false);
 const complete=async()=>{setPending(true);try{await useCardStore.getState().mutate(card.id,"/status",{status:"done",expectedVersion:card.version});}catch{}finally{setPending(false);}};
 return <div className="v3-card-actions">{card.status==="review" ? <DashboardIconCap label="완료" disabled={pending} onClick={()=>void complete()}><Check className="h-4 w-4"/></DashboardIconCap>:null}</div>;
}
export function cardStatusLabel(card:CardRow) {
 return {todo:"할 일",queued:"대기",blocked:card.blockedKind==="question"?"질문":card.blockedKind==="limit"?"한도 대기":"막힘",running:"실행 중",review:"검수",done:"완료",cancelled:"취소"}[card.status];
}

export function CardStatusChip({card}:{card:CardRow}) {
 return <span className={`v3-status-chip v3-card-status--${card.status}`}>{cardStatusLabel(card)}</span>;
}
