import type { CSSProperties, ReactNode } from "react";
import { DashboardIconCap, ProfileAvatar, useDashboardStore, type SessionSummary } from "@seosoyoung/soul-ui";
import { Check } from "lucide-react";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import type { CardActivity, CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { useCardCompletion, cardStatusLabel } from "./CardActions";
import { StatusChip } from "./StatusChip";
import { useCardNavigation } from "./card-navigation";
import { cardActivityPreview } from "./card-activity-preview";
import "./v3-postit-cards.css";

/** Same five ID-derived angles as corksheet, stable across renders and reloads. */
export function postItRotation(id: string): number {
  return ((id.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0) % 5) - 2) * 0.4;
}

export function PostItGrid({ children }: { children: ReactNode }) {
  return <div className="v3-postit-grid">{children}</div>;
}

/** List data already carries the latest original activity; mounting never loads detail. */
export function PostItCard({ card, handle }: { card: CardRow; handle?: ReactNode }) {
  const open = useCardNavigation(s => s.open);
  const completion = useCardCompletion(card);
  const assignee = useDashboardStore(s => s.catalog?.sessionList?.find(session => session.agentSessionId === card.assigneeSessionId));
  const error = useCardStore(s => s.errors[card.id]);
  return <PostItCardView card={card} activity={card.latestActivity ?? null} handle={handle} assignee={assignee}
    onOpen={() => open(card.id, "overlay")} completion={completion} error={error}/>;
}

export function PostItCardView({ card, activity, handle, assignee, onOpen, completion, error }: {
  card: CardRow; activity: Pick<CardActivity, "kind" | "body" | "format"> | null;
  handle?: ReactNode; assignee?: SessionSummary; onOpen(): void;
  completion?: { pending: boolean; onComplete(): void }; error?: string;
}) {
  const assigned = Boolean(card.assigneeKind);
  const nodeId = assignee?.nodeId ?? card.nodeId, agentId = assignee?.agentId ?? card.assigneeAgentId;
  const portrait = assigned ? assignee?.agentPortraitUrl ?? (nodeId && agentId
    ? `/api/nodes/${encodeURIComponent(nodeId)}/agents/${encodeURIComponent(agentId)}/portrait` : null) : null;
  const name = assigned ? assignee?.agentName ?? agentId ?? card.assigneeUserId ?? "담당 세션" : "담당 없음";
  const complete = card.status === "review" && completion;
  const actions = Boolean(handle || complete);
  const body = activity ? cardActivityPreview(activity) : "아직 지시나 보고가 없습니다";
  const tone = card.status === "blocked" && card.blockedKind === "question" ? "question" : card.status;
  return <article className={`v3-postit-card${actions ? " v3-postit-card--actions" : ""}`} data-card-id={card.id}
    data-card-status={card.status} style={{ "--postit-rotation": `${postItRotation(card.id)}deg` } as CSSProperties}>
    <button type="button" className="v3-postit-open" aria-label={`카드 ${card.title} 열기`} onClick={onOpen}>
      <span className="v3-postit-title" title={card.title}>{card.title}</span>
      <span className="v3-postit-latest-label">{activity ? activity.kind === "report" ? "마지막 보고" : "마지막 지시" : "지시·보고"}</span>
      <span className={`v3-postit-body${activity ? "" : " v3-postit-empty"}`}>{body}</span>
      <span className="v3-postit-footer">
        <span className="v3-postit-assignee"><ProfileAvatar role="assistant" hasPortrait={Boolean(portrait)} portraitUrl={portrait}
          fallbackEmoji={assigned ? card.assigneeKind === "human" ? "👤" : "🤖" : "·"}/><span title={name}>{name}</span></span>
        <StatusChip label={cardStatusLabel(card)} tone={tone}/>
      </span>
    </button>
    {actions ? <div className="v3-postit-actions">{handle}{complete ? <DashboardIconCap size="small" label="완료"
      disabled={completion.pending} onClick={event => { event.stopPropagation(); completion.onComplete(); }}>
      <Check className="h-4 w-4" aria-hidden="true"/>
    </DashboardIconCap> : null}</div> : null}
    {error ? <span className="v3-postit-error" role="alert">{error}</span> : null}
  </article>;
}
