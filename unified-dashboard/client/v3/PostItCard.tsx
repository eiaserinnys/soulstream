import { useEffect, useRef, useState, type HTMLAttributes, type Ref } from "react";
import { ProfileAvatar, useDashboardStore, type SessionSummary } from "@seosoyoung/soul-ui";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import type { CardActivity, CardRow, CardStatus } from "@seosoyoung/soul-ui/cards/card-types";
import type { CardQueueStatusActivator } from "@seosoyoung/soul-ui/cards/CardQueue";
import { cardStatusLabel } from "./CardActions";
import { StatusChip } from "./StatusChip";
import { useCardNavigation } from "./card-navigation";
import { cardActivityPreview } from "./card-activity-preview";
import { CardStatusPicker, type CardStatusControl, type CardStatusHandle } from "./CardStatusPicker";
import { usePostItStatus } from "./use-postit-status";
import { cardStatusChoices } from "./card-status-coordinator";
import { documentContextMenuTargetForKey } from "./document-context-menu-keyboard";
import { V3ContextMenu, type V3ContextMenuTarget } from "./V3ContextMenu";
import { useCardBoardLayer } from "./card-board-layer";
import "./v3-postit-cards.css";
import {PostItCardView as Paper, PostItGrid as PaperGrid, type PostItVariant} from "./PostItCardPresentation";
export {postItRotation} from "./PostItCardPresentation";
export type {PostItVariant} from "./PostItCardPresentation";

export function PostItGrid(props: HTMLAttributes<HTMLDivElement> & { variant?: PostItVariant; ref?:Ref<HTMLDivElement> }) {
  const fontSize=useDashboardStore(state=>state.chatFontSize);
  return <PaperGrid {...props} fontSize={fontSize}/>;
}

/** List data already carries the latest original activity; mounting never loads detail. */
export function PostItCard({ card, variant = "default", statusActivator }: { card: CardRow; variant?: PostItVariant; statusActivator?:CardQueueStatusActivator }) {
  const open = useCardNavigation(s => s.open);
  const status = usePostItStatus(card);
  const assignee = useDashboardStore(s => s.catalog?.sessionList?.find(session => session.agentSessionId === card.assigneeSessionId));
  const error = useCardStore(s => s.errors[card.id]);
  return <PostItCardView card={card} variant={variant} activity={card.latestActivity ?? null} assignee={assignee}
    onOpen={() => open(card.id, "overlay")} statusControl={status} statusActivator={statusActivator} error={error}/>;
}

export function PostItCardView({ card, activity, assignee, onOpen, statusControl, statusActivator, error, variant = "default" }: {
  card: CardRow; activity: Pick<CardActivity, "kind" | "body" | "format"> | null;
  assignee?: SessionSummary; onOpen(): void;
  statusControl?: CardStatusControl;
  statusActivator?:CardQueueStatusActivator; error?: string;
  variant?: PostItVariant;
}) {
  const statusHandle = useRef<CardStatusHandle>(null);
  const [contextTarget,setContextTarget]=useState<V3ContextMenuTarget|null>(null);
  const layer=useCardBoardLayer();
  useEffect(()=>{if(contextTarget)return layer?.claim();},[contextTarget,layer]);
  const fontSize = useDashboardStore(state => state.chatFontSize);
  const assigned = Boolean(card.assigneeKind);
  const nodeId = assignee?.nodeId ?? card.nodeId, agentId = assignee?.agentId ?? card.assigneeAgentId;
  const portrait = assigned ? assignee?.agentPortraitUrl ?? (nodeId && agentId
    ? `/api/nodes/${encodeURIComponent(nodeId)}/agents/${encodeURIComponent(agentId)}/portrait` : null) : null;
  const name = assigned ? assignee?.agentName ?? agentId ?? card.assigneeUserId ?? "담당 세션" : "담당 없음";
  const tone = card.status === "blocked" && card.blockedKind === "question" ? "question" : card.status;
  const statusActions=statusControl?cardStatusChoices.map(status=>({
    label:cardStatusLabel({...card,status,blockedKind:null,blockedDetail:null}),
    onSelect:()=>statusHandle.current?.request(status as CardStatus),
  })):[];
  return <>
    <Paper id={card.id} title={card.title} status={card.status} fontSize={fontSize} variant={variant}
      activity={activity?{kind:activity.kind,text:cardActivityPreview(activity)}:null}
      assigneeName={name} onOpen={onOpen} error={error}
      avatar={<ProfileAvatar role="assistant" hasPortrait={Boolean(portrait)} portraitUrl={portrait}
        fallbackEmoji={assigned ? card.assigneeKind === "human" ? "👤" : "🤖" : "·"}/>}
      statusContent={statusControl?<CardStatusPicker ref={statusHandle} card={card} control={statusControl} onOpen={onOpen} activator={statusActivator}/>:<StatusChip label={cardStatusLabel(card)} tone={tone}/>}
      onContextMenu={event=>{if(statusControl){event.preventDefault();event.stopPropagation();setContextTarget({x:event.clientX,y:event.clientY});}}}
      onKeyDown={event=>{
        if(!statusControl)return;
        const target=documentContextMenuTargetForKey(event,event.currentTarget.getBoundingClientRect());
        if(target){event.preventDefault();event.stopPropagation();setContextTarget(target);}
      }}/>
    <V3ContextMenu target={contextTarget} onClose={()=>setContextTarget(null)}
      actions={statusControl?[{label:"카드 ID 복사",onSelect:()=>navigator.clipboard.writeText(card.id)}]:[]}
      groups={statusControl?[{label:"카드 상태 변경",actions:statusActions}]:[]}/>
  </>;
}
