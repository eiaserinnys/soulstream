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
export function CardRow({card,folderLabel,handle}:{card:Card;folders?:readonly CatalogFolder[];placement?:"inline"|"overlay";handle?:ReactNode;showQueueAction?:boolean;folderLabel?:string}) {
 const open=useCardNavigation(s=>s.open);
 const completion=useCardCompletion(card);
 const assignee=useDashboardStore(s=>s.catalog?.sessionList?.find(session=>session.agentSessionId===card.assigneeSessionId));
 const detail=useCardStore(s=>s.details[card.id]);
 return <CardRowView card={card} folderLabel={folderLabel} handle={handle} assignee={assignee} detail={detail}
  onOpen={()=>open(card.id,"overlay")} completion={completion} />;
}
/** Shared row presentation; the operational wrapper owns fetching and navigation. */
export function CardRowView({card,folderLabel,handle,assignee,detail,onOpen,completion}: {
 card:Card;folderLabel?:string;handle?:ReactNode;assignee?:SessionSummary;detail?:CardDetail;
 onOpen():void;completion?:{pending:boolean;onComplete():void};
}) {
 const nodeId=assignee?.nodeId??card.nodeId,agentId=assignee?.agentId??card.assigneeAgentId;
 const portrait=assignee?.agentPortraitUrl??(nodeId&&agentId?`/api/nodes/${encodeURIComponent(nodeId)}/agents/${encodeURIComponent(agentId)}/portrait`:null);
 const name=assignee?.agentName??agentId??card.assigneeUserId??"담당 미지정";
 const latestReport=detail?.reports.reduce((latest,report)=>!latest||report.createdAt>latest.createdAt?report:latest,detail.reports[0]);
 const latestComment=detail?.comments?.reduce((latest,comment)=>!latest||comment.createdAt>latest.createdAt?comment:latest,detail.comments[0]);
 const source=card.latestActivity ? cardActivityPreview(card.latestActivity) : latestReport?.title??latestComment?.body??card.request??"";
 const preview=singleLinePreview(source.split(/\r?\n/)[0],TASK_TITLE_PREVIEW_LENGTH);
 return <RunRowFrame variant="card" cardId={card.id} blockedKind={card.blockedKind} handle={handle}
  openLabel={`카드 ${card.title} 열기`} onOpen={onOpen}
  avatar={<ProfileAvatar role="assistant" hasPortrait={Boolean(portrait)} portraitUrl={portrait} fallbackEmoji={card.assigneeKind==="human"?"👤":"🤖"}/>}
  title={<strong title={card.title}>{card.title}</strong>}
  agentLine={<>{folderLabel?<span>{folderLabel}</span>:null}<span>{name}</span><span>{nodeId??"노드 미상"}</span><span>{assignee?.modelLabel??card.modelPreset??"모델 미지정"}</span></>}
  preview={preview??""}
  status={{label:`카드 ${card.status==="running"?"진행 중":cardStatusLabel(card)}`,tone:card.status==="blocked"&&card.blockedKind==="question"?"question":card.status}}
  timestamp={{display:cardElapsed(card.updatedAt),raw:card.updatedAt}}
  actions={card.status==="review" ? completion?[{kind:"complete",label:"완료",pending:completion.pending,onAction:completion.onComplete}]:undefined : [{kind:"open",label:"카드 열기",onAction:onOpen}]}
 />;
}
function cardElapsed(timestamp:string) {
 const minutes=Math.max(0,Math.floor((Date.now()-Date.parse(timestamp))/60000));
 return minutes<1?"방금 전":minutes<60?`${minutes}분 전`:minutes<1440?`${Math.floor(minutes/60)}시간 전`:`${Math.floor(minutes/1440)}일 전`;
}
