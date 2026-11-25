import { useState } from "react";
import type { CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import { CARD_BOARD_STATUS_LABELS } from "@seosoyoung/soul-ui/lib/card-board-status-labels";
import { StatusChip } from "./StatusChip";
import { cardDependencyStopReason, type CardDependency } from "../../../packages/wire-schema/src/card_dependency_display";

export function useCardCompletion(card:CardRow) {
 const [pending,setPending]=useState(false);
 const complete=async()=>{setPending(true);try{await useCardStore.getState().mutate(card.id,"/status",{status:"done",expectedVersion:card.version});}catch{}finally{setPending(false);}};
 return {pending,onComplete:()=>void complete()};
}
export function cardStatusLabel(card:Pick<CardRow,"status"|"blockedKind"> & Partial<Pick<CardRow,"blockedDetail">>) {
 if (card.status === "blocked") return card.blockedKind==="question" ? "질문" : card.blockedKind==="limit" ? "한도 대기" : "막힘";
 return CARD_BOARD_STATUS_LABELS[card.status];
}

/** 선행 카드 한 장의 상태 칩. 충족되지 않은 채 보관된 선행은 「대기」가 아니라 「보관됨」으로 보인다. */
export function cardDependencyStatus(dep:CardDependency):{label:string;tone:string} {
 return cardDependencyStopReason(dep)==="archived"?{label:"보관됨",tone:"error"}:{label:cardStatusLabel({status:dep.status,blockedKind:null}),tone:dep.status};
}

export function CardStatusChip({card}:{card:Pick<CardRow,"status"|"blockedKind"> & Partial<Pick<CardRow,"blockedDetail">>}) {
 return <StatusChip label={`카드 ${card.status==="running"?"진행 중":cardStatusLabel(card)}`} tone={card.status==="blocked"&&card.blockedKind==="question"?"question":card.status} className={`v3-card-status--${card.status}`}/>;
}
