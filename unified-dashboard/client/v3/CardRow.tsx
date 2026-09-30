import type { ReactNode } from "react";
import { ProfileAvatar, type CatalogFolder } from "@seosoyoung/soul-ui";
import { LiquidGlassCard } from "@seosoyoung/soul-ui/components/LiquidGlassCard";
import type { CardRow as Card } from "@seosoyoung/soul-ui/cards/card-types";
import { CardActions, CardStatusChip } from "./CardActions";
import { useCardNavigation } from "./card-navigation";
import "./v3-run-history.css";
import "./v3-cards.css";
export function CardRow({card,folders=[],placement="inline",handle,showQueueAction=true}:{card:Card;folders?:readonly CatalogFolder[];placement?:"inline"|"overlay";handle?:ReactNode;showQueueAction?:boolean}) {
 const open=useCardNavigation(s=>s.open);
 const portrait=card.nodeId&&card.assigneeAgentId?`/api/nodes/${encodeURIComponent(card.nodeId)}/agents/${encodeURIComponent(card.assigneeAgentId)}/portrait`:null;
 return <LiquidGlassCard webglSurface className="v3-run-row v3-card-row" data-card-id={card.id}>
   {handle}
   <button type="button" className="v3-run-open v3-card-open" onClick={()=>open(card.id,placement)} aria-label={`카드 ${card.title} 열기`}>
     <CardStatusChip card={card}/><span className="v3-run-copy"><strong title={card.title}>{card.title}</strong>
     <span className="v3-card-folder">{folders.find(f=>f.id===card.folderId)?.name??""}</span></span>
     <span className="v3-run-avatar" title={card.assigneeAgentId??card.assigneeUserId??"담당 미지정"}><ProfileAvatar role="assistant" hasPortrait={Boolean(portrait)} portraitUrl={portrait} fallbackEmoji={card.assigneeKind==="human"?"👤":"🤖"}/></span>
   </button>
   <div className="v3-run-row-actions">{card.status!=="queued"||showQueueAction?<CardActions card={card} onAnswer={()=>open(card.id,placement,"questions")}/>:null}</div>
 </LiquidGlassCard>;
}
