import { useState } from "react";
import type { CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import { StatusChip } from "./StatusChip";

export function useCardCompletion(card:CardRow) {
 const [pending,setPending]=useState(false);
 const complete=async()=>{setPending(true);try{await useCardStore.getState().mutate(card.id,"/status",{status:"done",expectedVersion:card.version});}catch{}finally{setPending(false);}};
 return {pending,onComplete:()=>void complete()};
}
export function cardStatusLabel(card:CardRow) {
 return {todo:"할 일",queued:"대기",blocked:card.blockedKind==="question"?"질문":card.blockedKind==="limit"?"한도 대기":"막힘",running:"실행 중",review:"검수",done:"완료",cancelled:"취소"}[card.status];
}

export function CardStatusChip({card}:{card:CardRow}) {
 return <StatusChip label={`카드 ${card.status==="running"?"진행 중":cardStatusLabel(card)}`} tone={card.status==="blocked"&&card.blockedKind==="question"?"question":card.status} className={`v3-card-status--${card.status}`}/>;
}
