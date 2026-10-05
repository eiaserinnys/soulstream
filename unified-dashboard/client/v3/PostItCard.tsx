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
import { summarizeCardItems } from "./card-item-summary";
import { CardProgressSummary } from "./CardProgressSummary";
export {postItRotation} from "./PostItCardPresentation";
export type {PostItVariant} from "./PostItCardPresentation";
const NO_PENDING_CONFIRMATIONS:Readonly<Record<number,boolean>>={};

export function PostItGrid(props: HTMLAttributes<HTMLDivElement> & { variant?: PostItVariant; ref?:Ref<HTMLDivElement> }) {
  const fontSize=useDashboardStore(state=>state.chatFontSize);
  return <PaperGrid {...props} fontSize={fontSize}/>;
}

/** List data already carries the latest original activity; mounting never loads detail. */
export function PostItCard({ card, variant = "default", statusActivator }: { card: CardRow; variant?: PostItVariant; statusActivator?:CardQueueStatusActivator }) {
  const currentCard=useCardStore(state=>state.byId[card.id]??card);
  const pendingConfirmations=useCardStore(state=>state.pendingItemConfirmations[card.id]??NO_PENDING_CONFIRMATIONS);
  const open = useCardNavigation(s => s.open);
  const status = usePostItStatus(currentCard);
  const assignee = useDashboardStore(s => s.catalog?.sessionList?.find(session => session.agentSessionId === currentCard.assigneeSessionId));
  const error = useCardStore(s => s.errors[currentCard.id]);
  return <PostItCardView card={currentCard} pendingConfirmations={pendingConfirmations} variant={variant} activity={currentCard.latestActivity ?? null} assignee={assignee}
    onOpen={() => open(currentCard.id, "overlay")} statusControl={status} statusActivator={statusActivator} error={error}/>;
}

export function PostItCardView({ card, activity, assignee, onOpen, statusControl, statusActivator, error, variant = "default", pendingConfirmations=NO_PENDING_CONFIRMATIONS }: {
  card: CardRow; activity: Pick<CardActivity, "kind" | "body" | "format"> | null;
  assignee?: SessionSummary; onOpen(): void;
  statusControl?: CardStatusControl;
  statusActivator?:CardQueueStatusActivator; error?: string;
  variant?: PostItVariant;
  pendingConfirmations?:Readonly<Record<number,boolean>>;
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
  const itemSummary=summarizeCardItems(card.items,pendingConfirmations);
  const hasItems=Boolean(card.items?.length);
  const nowText=card.now?.text;
  const turnText=card.now?.turn==="user"?"볼 것 "+itemSummary.toReviewCount+(card.now.ask?" · "+card.now.ask:""):undefined;
  const statusActions=statusControl?cardStatusChoices.map(status=>({
    label:cardStatusLabel({...card,status,blockedKind:null,blockedDetail:null}),
    onSelect:()=>statusHandle.current?.request(status as CardStatus),
  })):[];
  return <>
    <Paper id={card.id} title={card.title} status={card.status} color={card.color} fontSize={fontSize} variant={variant}
      activity={activity?{kind:activity.kind,text:cardActivityPreview(activity)}:null}
      summary={hasItems?<span className="v3-postit-summary"><CardProgressSummary summary={itemSummary}/></span>:undefined} nowText={nowText} turnText={turnText}
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
      actions={statusControl?[
        {label:"카드 ID 복사",onSelect:()=>navigator.clipboard.writeText(card.id)},
        ...(statusControl.changeColor?[{label:"카드 색상 변경",separatorBefore:true,onSelect:()=>statusHandle.current?.requestColor()}]:[]),
      ]:[]}
      groups={statusControl?[{label:"카드 상태 변경",actions:statusActions}]:[]}/>
  </>;
}
