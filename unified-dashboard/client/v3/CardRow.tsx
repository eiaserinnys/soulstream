import { type ReactNode } from "react";
import { ProfileAvatar, useDashboardStore, type CatalogFolder, type SessionSummary } from "@seosoyoung/soul-ui";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import type { CardRow as Card, CardDetail } from "@seosoyoung/soul-ui/cards/card-types";
import { useCardCompletion, cardStatusLabel } from "./CardActions";
import { RunRowFrame } from "./RunRowFrame";
import { useCardNavigation } from "./card-navigation";
import { TASK_TITLE_PREVIEW_LENGTH, singleLinePreview } from "./session-preview";
import "./v3-run-history.css";
import "./v3-cards.css";
import { cardActivityPreview } from "./card-activity-preview";
import { summarizeCardItems } from "./card-item-summary";
import { CardProgressSummary } from "./CardProgressSummary";
const NO_PENDING_CONFIRMATIONS:Readonly<Record<number,boolean>>={};
export function CardRow({card,folderLabel,handle}:{card:Card;folders?:readonly CatalogFolder[];placement?:"inline"|"overlay";handle?:ReactNode;showQueueAction?:boolean;folderLabel?:string}) {
 const open=useCardNavigation(s=>s.open);
 const currentCard=useCardStore(s=>s.byId[card.id]??card);
 const pendingConfirmations=useCardStore(s=>s.pendingItemConfirmations[card.id]??NO_PENDING_CONFIRMATIONS);
 const completion=useCardCompletion(currentCard);
 const assignee=useDashboardStore(s=>s.catalog?.sessionList?.find(session=>session.agentSessionId===currentCard.assigneeSessionId));
 const detail=useCardStore(s=>s.details[currentCard.id]);
 return <CardRowView card={currentCard} pendingConfirmations={pendingConfirmations} folderLabel={folderLabel} handle={handle} assignee={assignee} detail={detail}
  onOpen={()=>open(currentCard.id,"overlay")} completion={completion} />;
}
/** Shared row presentation; the operational wrapper owns navigation and completion. */
export function CardRowView({card,folderLabel,handle,assignee,detail,onOpen,completion,pendingConfirmations=NO_PENDING_CONFIRMATIONS}: {
 card:Card;folderLabel?:string;handle?:ReactNode;assignee?:SessionSummary;detail?:CardDetail;
 onOpen():void;completion?:{pending:boolean;onComplete():void};
 pendingConfirmations?:Readonly<Record<number,boolean>>;
}) {
 const nodeId=assignee?.nodeId??card.nodeId,agentId=assignee?.agentId??card.assigneeAgentId;
 const portrait=assignee?.agentPortraitUrl??(nodeId&&agentId?`/api/nodes/${encodeURIComponent(nodeId)}/agents/${encodeURIComponent(agentId)}/portrait`:null);
 const name=assignee?.agentName??agentId??card.assigneeUserId??"담당 미지정";
 const latestReport=detail?.reports.reduce((latest,report)=>!latest||report.createdAt>latest.createdAt?report:latest,detail.reports[0]);
 const latestComment=detail?.comments?.reduce((latest,comment)=>!latest||comment.createdAt>latest.createdAt?comment:latest,detail.comments[0]);
 const source=card.latestActivity ? cardActivityPreview(card.latestActivity) : card.latestActivity===null ? card.request??"" : latestReport?.title??latestComment?.body??card.request??"";
 const preview=singleLinePreview((card.now?.text??source).split(/\r?\n/)[0],TASK_TITLE_PREVIEW_LENGTH);
 const itemSummary=summarizeCardItems(card.items,pendingConfirmations);
 const hasItems=Boolean(card.items?.length);
 const cardTurn=card.now?.turn==="user"?"볼 것 "+itemSummary.toReviewCount+(card.now.ask?", "+card.now.ask:""):undefined;
 return <RunRowFrame variant="card" cardId={card.id} blockedKind={card.blockedKind} handle={handle}
  openLabel={`카드 ${card.title} 열기`} onOpen={onOpen}
  avatar={<ProfileAvatar role="assistant" hasPortrait={Boolean(portrait)} portraitUrl={portrait} fallbackEmoji={card.assigneeKind==="human"?"👤":"🤖"}/>}
  title={<strong title={card.title}>{card.title}</strong>}
  agentLine={<>{folderLabel?<span>{folderLabel}</span>:null}<span>{name}</span><span>{nodeId??"노드 미상"}</span><span>{assignee?.modelLabel??card.modelPreset??"모델 미지정"}</span></>}
  preview={preview??""}
  status={{label:`카드 ${card.status==="running"?"진행 중":cardStatusLabel(card)}`,tone:card.status==="blocked"&&card.blockedKind==="question"?"question":card.status}}
  timestamp={{display:cardElapsed(card.updatedAt),raw:card.updatedAt}}
  cardSummary={hasItems?<CardProgressSummary summary={itemSummary}/>:undefined} cardTurn={cardTurn}
  actions={card.status==="review" ? completion?[{kind:"complete",label:"완료",pending:completion.pending,onAction:completion.onComplete}]:undefined : [{kind:"open",label:"카드 열기",onAction:onOpen}]}
 />;
}
function cardElapsed(timestamp:string) {
 const minutes=Math.max(0,Math.floor((Date.now()-Date.parse(timestamp))/60000));
 return minutes<1?"방금 전":minutes<60?`${minutes}분 전`:minutes<1440?`${Math.floor(minutes/60)}시간 전`:`${Math.floor(minutes/1440)}일 전`;
}
