import type { ReactNode } from "react";
import { ProfileAvatar, useDashboardStore, type CatalogFolder } from "@seosoyoung/soul-ui";
import { LiquidGlassCard } from "@seosoyoung/soul-ui/components/LiquidGlassCard";
import type { CardRow as Card } from "@seosoyoung/soul-ui/cards/card-types";
import { CardActions, CardStatusChip } from "./CardActions";
import { useCardNavigation } from "./card-navigation";
import "./v3-run-history.css";
import "./v3-cards.css";
export function CardRow({card,folderLabel,handle}:{card:Card;folders?:readonly CatalogFolder[];placement?:"inline"|"overlay";handle?:ReactNode;showQueueAction?:boolean;folderLabel?:string}) {
 const open=useCardNavigation(s=>s.open);
 const assignee=useDashboardStore(s=>s.catalog?.sessionList?.find(session=>session.agentSessionId===card.assigneeSessionId));
 const nodeId=assignee?.nodeId??card.nodeId,agentId=assignee?.agentId??card.assigneeAgentId;
 const portrait=assignee?.agentPortraitUrl??(nodeId&&agentId?`/api/nodes/${encodeURIComponent(nodeId)}/agents/${encodeURIComponent(agentId)}/portrait`:null);
 const name=assignee?.agentName??agentId??card.assigneeUserId??"담당 미지정";
 return <LiquidGlassCard webglSurface className="v3-run-row v3-card-row" data-card-id={card.id} data-blocked-kind={card.blockedKind}>
  {handle}<div className="v3-run-open v3-card-open">
   <button type="button" className="v3-card-avatar-link" aria-label={`카드 ${card.title} 열기`} onClick={()=>open(card.id,"inline")}><span className="v3-run-avatar" title={name}><ProfileAvatar role="assistant" hasPortrait={Boolean(portrait)} portraitUrl={portrait} fallbackEmoji={card.assigneeKind==="human"?"👤":"🤖"}/></span></button>
   <span className="v3-run-copy"><span className="v3-run-title-line"><CardStatusChip card={card}/><button type="button" className="v3-card-link" onClick={()=>open(card.id,"inline")}><strong title={card.title}>{card.title}</strong></button></span>
    <span className="v3-card-meta"><span className="v3-card-folder">{folderLabel??name}</span><span aria-hidden="true">·</span><time dateTime={card.updatedAt}>{cardElapsed(card.updatedAt)}</time></span></span>
  </div><div className="v3-run-row-actions"><CardActions card={card}/></div>
 </LiquidGlassCard>;
}
function cardElapsed(timestamp:string) {
 const minutes=Math.max(0,Math.floor((Date.now()-Date.parse(timestamp))/60000));
 return minutes<1?"방금 전":minutes<60?`${minutes}분 전`:minutes<1440?`${Math.floor(minutes/60)}시간 전`:`${Math.floor(minutes/1440)}일 전`;
}
