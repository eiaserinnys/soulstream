import { useTranslation } from "react-i18next";
import { useState } from "react";
import type { CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import { CARD_BOARD_STATUS_LABELS } from "@seosoyoung/soul-ui/lib/card-board-status-labels";
import { StatusChip } from "@seosoyoung/soul-ui";
import { cardDependencyStopReason, type CardDependency } from "../../../packages/wire-schema/src/card_dependency_display";

export function useCardCompletion(card:CardRow) {
 const {t}=useTranslation();
 const [pending,setPending]=useState(false);
 const complete=async()=>{setPending(true);try{await useCardStore.getState().mutate(card.id,"/status",{status:"done",expectedVersion:card.version}, "POST", t);}catch{}finally{setPending(false);}};
 return {pending,onComplete:()=>void complete()};
}
export function cardStatusLabel(card:Pick<CardRow,"status"|"blockedKind"> & Partial<Pick<CardRow,"blockedDetail">>, t:ReturnType<typeof useTranslation>["t"]) {
 if (card.status === "blocked") return card.blockedKind==="question" ? t("cards.question") : card.blockedKind==="limit" ? t("cards.quotaWait") : t("cards.blocked");
 return card.status==="todo"?t("cards.draft"):t(`cards.status.${card.status}`,{defaultValue:CARD_BOARD_STATUS_LABELS[card.status]});
}

/** 선행 카드 한 장의 상태 칩. 충족되지 않은 채 보관된 선행은 「대기」가 아니라 「보관됨」으로 보인다. */
export function cardDependencyStatus(dep:CardDependency,t:ReturnType<typeof useTranslation>["t"]):{label:string;tone:string} {
 return cardDependencyStopReason(dep)==="archived"?{label:t("cards.archived"),tone:"error"}:{label:cardStatusLabel({status:dep.status,blockedKind:null},t),tone:dep.status};
}

export function cardDependencyNotice(
  card:Pick<CardRow,"status"|"dependsOn">,
  t:ReturnType<typeof useTranslation>["t"],
):{text:string;tone:"neutral"|"error"}|null {
 const dependencies=card.dependsOn;
 if(card.status!=="queued"||!dependencies?.length)return null;
 const name=(dep:CardDependency)=>dep.number==null?dep.title:`#${dep.number}`;
 const stopped=dependencies.find(cardDependencyStopReason);
 if(stopped)return {
  text:t(cardDependencyStopReason(stopped)==="cancelled"?"cards.dependencyCancelled":"cards.dependencyArchived",{name:name(stopped)}),
  tone:"error",
 };
 const waiting=dependencies.filter(dep=>!dep.met);
 if(!waiting.length)return null;
 const names=waiting.length>2
  ?t("cards.moreDependencies",{name:name(waiting[0]!),count:waiting.length-1})
  :waiting.map(name).join(", ");
 return {text:t("cards.waitingForDependencies",{names}),tone:"neutral"};
}

export function CardStatusChip({card}:{card:Pick<CardRow,"status"|"blockedKind"> & Partial<Pick<CardRow,"blockedDetail">>}) {
 const {t}=useTranslation();
 return <StatusChip label={t("cards.cardStatus",{status:cardStatusLabel(card,t)})} tone={card.status==="blocked"&&card.blockedKind==="question"?"question":card.status} className={`v3-card-status--${card.status}`}/>;
}
