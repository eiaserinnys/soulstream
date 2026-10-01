import { useEffect, type ReactNode } from "react";
import { ProfileAvatar, useDashboardStore, type CatalogFolder } from "@seosoyoung/soul-ui";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import type { CardRow as Card } from "@seosoyoung/soul-ui/cards/card-types";
import { DashboardIconCap } from "@seosoyoung/soul-ui";
import { ChevronRight } from "lucide-react";
import { CardActions, cardStatusLabel } from "./CardActions";
import { RunRowFrame } from "./RunRowFrame";
import { useCardNavigation } from "./card-navigation";
import { TASK_TITLE_PREVIEW_LENGTH, singleLinePreview } from "./session-preview";
import "./v3-run-history.css";
import "./v3-cards.css";
export function CardRow({card,folderLabel,handle}:{card:Card;folders?:readonly CatalogFolder[];placement?:"inline"|"overlay";handle?:ReactNode;showQueueAction?:boolean;folderLabel?:string}) {
 const open=useCardNavigation(s=>s.open);
 const assignee=useDashboardStore(s=>s.catalog?.sessionList?.find(session=>session.agentSessionId===card.assigneeSessionId));
 const detail=useCardStore(s=>s.details[card.id]);
 useEffect(()=>{if(!useCardStore.getState().details[card.id])void useCardStore.getState().loadCard(card.id).catch(()=>undefined);},[card.id]);
 const nodeId=assignee?.nodeId??card.nodeId,agentId=assignee?.agentId??card.assigneeAgentId;
 const portrait=assignee?.agentPortraitUrl??(nodeId&&agentId?`/api/nodes/${encodeURIComponent(nodeId)}/agents/${encodeURIComponent(agentId)}/portrait`:null);
 const name=assignee?.agentName??agentId??card.assigneeUserId??"담당 미지정";
 const latestReport=detail?.reports.reduce((latest,report)=>!latest||report.createdAt>latest.createdAt?report:latest,detail.reports[0]);
 const latestComment=detail?.comments?.reduce((latest,comment)=>!latest||comment.createdAt>latest.createdAt?comment:latest,detail.comments[0]);
 const preview=singleLinePreview((latestReport?.title??latestComment?.body??card.request??"").split(/\r?\n/)[0],TASK_TITLE_PREVIEW_LENGTH);
 return <RunRowFrame className="v3-card-row" data-card-id={card.id} data-blocked-kind={card.blockedKind} handle={handle}
  openLabel={`카드 ${card.title} 열기`} onOpen={()=>open(card.id,"overlay")} interactiveTrailing
  avatar={<ProfileAvatar role="assistant" hasPortrait={Boolean(portrait)} portraitUrl={portrait} fallbackEmoji={card.assigneeKind==="human"?"👤":"🤖"}/>}
  title={<strong title={card.title}><span className={`v3-card-status--${card.status}`}>{cardStatusLabel(card)}</span> {card.title}</strong>}
  agentLine={<>{folderLabel?<span>{folderLabel}</span>:null}<span>{name}</span><span>{nodeId??"노드 미상"}</span><span>{assignee?.modelLabel??card.modelPreset??"모델 미지정"}</span></>}
  preview={preview??""} trailing={<><time dateTime={card.updatedAt}>{cardElapsed(card.updatedAt)}</time>{card.status==="review"?<CardActions card={card}/>:<DashboardIconCap label="카드 열기" onClick={()=>open(card.id,"overlay")}><ChevronRight className="h-4 w-4"/></DashboardIconCap>}</>}
 />;
}
function cardElapsed(timestamp:string) {
 const minutes=Math.max(0,Math.floor((Date.now()-Date.parse(timestamp))/60000));
 return minutes<1?"방금 전":minutes<60?`${minutes}분 전`:minutes<1440?`${Math.floor(minutes/60)}시간 전`:`${Math.floor(minutes/1440)}일 전`;
}
