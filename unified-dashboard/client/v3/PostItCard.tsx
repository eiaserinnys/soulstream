import { useRef, useState, type HTMLAttributes, type ReactNode, type Ref } from "react";
import { DashboardIconCap, ProfileAvatar, useDashboardStore, type SessionSummary } from "@seosoyoung/soul-ui";
import { Check } from "lucide-react";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import type { CardActivity, CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { cardStatusLabel } from "./CardActions";
import { StatusChip } from "./StatusChip";
import { useCardNavigation } from "./card-navigation";
import { cardActivityPreview } from "./card-activity-preview";
import { CardStatusPicker, type CardStatusControl, type CardStatusHandle } from "./CardStatusPicker";
import { usePostItStatus } from "./use-postit-status";
import "./v3-postit-cards.css";
import {PostItCardView as Paper, PostItGrid as PaperGrid, type PostItVariant} from "./PostItCardPresentation";
export {postItRotation} from "./PostItCardPresentation";
export type {PostItVariant} from "./PostItCardPresentation";

export function PostItGrid(props: HTMLAttributes<HTMLDivElement> & { variant?: PostItVariant; ref?:Ref<HTMLDivElement> }) {
  const fontSize=useDashboardStore(state=>state.chatFontSize);
  return <PaperGrid {...props} fontSize={fontSize}/>;
}

/** List data already carries the latest original activity; mounting never loads detail. */
export function PostItCard({ card, handle, variant = "default", preview=false }: { card: CardRow; handle?: ReactNode; variant?: PostItVariant; preview?:boolean }) {
  const open = useCardNavigation(s => s.open);
  const completion = usePostItStatus(card);
  const assignee = useDashboardStore(s => s.catalog?.sessionList?.find(session => session.agentSessionId === card.assigneeSessionId));
  const error = useCardStore(s => s.errors[card.id]);
  return <PostItCardView card={card} variant={variant} activity={card.latestActivity ?? null} handle={handle} assignee={assignee}
    onOpen={() => open(card.id, "overlay")} completion={preview?undefined:completion} statusControl={preview?undefined:completion} error={error}/>;
}

export function PostItCardView({ card, activity, handle, assignee, onOpen, completion, statusControl, error, variant = "default" }: {
  card: CardRow; activity: Pick<CardActivity, "kind" | "body" | "format"> | null;
  handle?: ReactNode; assignee?: SessionSummary; onOpen(): void;
  statusControl?: CardStatusControl;
  completion?: { pending: boolean; onComplete(): void }; error?: string;
  variant?: PostItVariant;
}) {
  const [statusBusy,setStatusBusy]=useState(false);
  const statusHandle = useRef<CardStatusHandle>(null);
  const fontSize = useDashboardStore(state => state.chatFontSize);
  const assigned = Boolean(card.assigneeKind);
  const nodeId = assignee?.nodeId ?? card.nodeId, agentId = assignee?.agentId ?? card.assigneeAgentId;
  const portrait = assigned ? assignee?.agentPortraitUrl ?? (nodeId && agentId
    ? `/api/nodes/${encodeURIComponent(nodeId)}/agents/${encodeURIComponent(agentId)}/portrait` : null) : null;
  const name = assigned ? assignee?.agentName ?? agentId ?? card.assigneeUserId ?? "담당 세션" : "담당 없음";
  const complete = card.status === "review" && completion;
  const tone = card.status === "blocked" && card.blockedKind === "question" ? "question" : card.status;
  return <Paper id={card.id} title={card.title} status={card.status} fontSize={fontSize} variant={variant}
    activity={activity?{kind:activity.kind,text:cardActivityPreview(activity)}:null}
    assigneeName={name} onOpen={onOpen} error={error} twoActions={Boolean(handle&&complete)}
    avatar={<ProfileAvatar role="assistant" hasPortrait={Boolean(portrait)} portraitUrl={portrait}
      fallbackEmoji={assigned ? card.assigneeKind === "human" ? "👤" : "🤖" : "·"}/>}
    statusContent={statusControl?<CardStatusPicker ref={statusHandle} onBusyChange={setStatusBusy} card={card} control={statusControl} onOpen={onOpen}/>:<StatusChip label={cardStatusLabel(card)} tone={tone}/>}
    actions={handle||complete?<>{handle}{complete?<DashboardIconCap size="small" label="완료"
      disabled={completion.pending||statusBusy} onClick={event=>{event.stopPropagation();if(statusControl)statusHandle.current?.request("done");else completion.onComplete();}}>
      <Check className="h-4 w-4" aria-hidden="true"/>
    </DashboardIconCap>:null}</>:undefined}
    onContextMenu={event=>{if(statusControl){event.preventDefault();event.stopPropagation();statusHandle.current?.request();}}}
    onKeyDown={event=>{if(statusControl&&(event.key==="ContextMenu"||event.shiftKey&&event.key==="F10")){event.preventDefault();event.stopPropagation();statusHandle.current?.request();}}}/>
}
