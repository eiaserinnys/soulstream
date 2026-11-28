import { useTranslation } from "react-i18next";
import {CardCreateDialog} from "./CardCreateDialog";
import { useState, type ReactNode } from "react";
import { DashboardIconCap, type CatalogFolder } from "@seosoyoung/soul-ui";
import { LayoutDashboard, List, Plus } from "lucide-react";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import { groupCards } from "@seosoyoung/soul-ui/cards/card-api";
import { CardQueue } from "@seosoyoung/soul-ui/cards/CardQueue";
import { PostItCard, PostItGrid } from "./PostItCard";
import { CardInboxBoard } from "./CardInboxBoard";
import { CardCompletionFilter } from "./CardCompletionFilter";
import { useCompletedCards } from "./use-completed-cards";
import { CompletedCardCollection } from "./CompletedCardCollection";
export function CardInbox({folders,initialBoard=false,actions}:{folders:readonly CatalogFolder[];initialBoard?:boolean;actions?:ReactNode}) {
 const {t}=useTranslation();
 const byId=useCardStore(s=>s.byId);const groups=groupCards(Object.values(byId));
 const [adding,setAdding]=useState(false);
 const [board,setBoard]=useState(initialBoard);
 const [includeCompleted,setIncludeCompleted]=useState(false);
 const completed=useCompletedCards(undefined,includeCompleted);
 const [createdIds,setCreatedIds]=useState<string[]>([]);
 const empty=!groups.attention.length&&!groups.running.length&&!groups.queued.length;
 if(board)return <div className="v3-card-inbox" data-card-scope="all">
  <CardInboxBoard createdIds={createdIds} completion={{includeCompleted,onChange:setIncludeCompleted}} completed={completed}
   actions={<>{actions}<DashboardIconCap size="small" label={t("cards.inboxView")} onClick={()=>setBoard(false)}><List className="h-4 w-4"/></DashboardIconCap></>}
   draftAction={<DashboardIconCap size="small" label={t("cards.newCard")} onClick={()=>setAdding(true)}><Plus className="h-4 w-4"/></DashboardIconCap>}/>
  {adding?<CardCreateDialog folders={folders} onCreated={id=>setCreatedIds(ids=>[...ids,id])} onClose={()=>setAdding(false)}/>:null}
 </div>;
 return <div className="v3-card-inbox">{adding?<CardCreateDialog folders={folders} onClose={()=>setAdding(false)}/>:null}<div className="v3-detail-section-head v3-folder-card-head"><h3>{t("cards.allCards")}</h3><span className="v3-spacer"/><CardCompletionFilter includeCompleted={includeCompleted} onChange={setIncludeCompleted}/><div className="v3-card-actions">{actions}<DashboardIconCap size="small" label={t("cards.board")} onClick={()=>setBoard(true)}><LayoutDashboard className="h-4 w-4"/></DashboardIconCap><DashboardIconCap size="small" label={t("cards.addCard")} onClick={()=>setAdding(true)}><Plus className="h-4 w-4"/></DashboardIconCap></div></div>{(["attention","running","queued"] as const).filter(group=>group==="attention"||groups[group].length>0).map(group=><section key={group} data-card-group={group}>
  <div className="v3-section-head"><h2>{{attention:t("cards.needsAttention"),running:t("cards.inProgress"),queued:t("cards.queue")}[group]}</h2><span>{groups[group].length}</span></div>

  {group==="attention"&&empty?<div className="v3-card-inbox-empty"><strong>{t("cards.inboxEmpty")}</strong><span>{t("cards.inboxEmptyHint")}</span></div>:null}
  <PostItGrid>{group==="queued"?<CardQueue t={t} layout="grid" activatorMode="status-chip" cards={groups.queued} renderRow={(card,_handle,activator)=><PostItCard card={card} statusActivator={activator}/>}/>:groups[group].map(card=><PostItCard key={card.id} card={card}/>)}</PostItGrid>
 </section>)}{includeCompleted?<CompletedCardCollection browser={completed} heading="section" renderCard={card=><PostItCard card={card}/>}/>:null}</div>;
}
