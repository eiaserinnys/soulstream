import { useState } from "react";
import type { CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import { CARD_BOARD_STATUS_LABELS } from "@seosoyoung/soul-ui/lib/card-board-status-labels";
import { StatusChip } from "./StatusChip";

export function useCardCompletion(card:CardRow) {
 const [pending,setPending]=useState(false);
 const complete=async()=>{setPending(true);try{await useCardStore.getState().mutate(card.id,"/status",{status:"done",expectedVersion:card.version});}catch{}finally{setPending(false);}};
 return {pending,onComplete:()=>void complete()};
}
export function cardStatusLabel(card:Pick<CardRow,"status"|"blockedKind"> & Partial<Pick<CardRow,"blockedDetail">>) {
 if (card.status === "blocked") return card.blockedKind==="question" ? "질문" : card.blockedKind==="limit" ? "한도 대기" : "막힘";
 return CARD_BOARD_STATUS_LABELS[card.status];
}

export function CardStatusChip({card}:{card:Pick<CardRow,"status"|"blockedKind"> & Partial<Pick<CardRow,"blockedDetail">>}) {
 return <StatusChip label={`카드 ${card.status==="running"?"진행 중":cardStatusLabel(card)}`} tone={card.status==="blocked"&&card.blockedKind==="question"?"question":card.status} className={`v3-card-status--${card.status}`}/>;
}
