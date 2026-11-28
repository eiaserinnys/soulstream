import { useTranslation } from "react-i18next";
import {CardCreateDialog} from "./CardCreateDialog";
import {compareStatusChange} from "@seosoyoung/soul-ui/cards/card-order";
import { useState } from "react";
import { DashboardIconCap, FrameLoading, type CatalogFolder } from "@seosoyoung/soul-ui";
import { V3ErrorNotice } from "./V3ErrorNotice";
import { LayoutDashboard, List, Plus } from "lucide-react";
import { PostItCard, PostItGrid } from "./PostItCard";
import { CardBoardWorkspace } from "./CardBoardWorkspace";
import { CardCompletionFilter } from "./CardCompletionFilter";
import { useCardMembership } from "./use-card-membership";
import { useCompletedCards } from "./use-completed-cards";
import { CompletedCardCollection } from "./CompletedCardCollection";
export function FolderCardSection({folderId,folders=[],placement="inline"}:{folderId:string;folders?:readonly CatalogFolder[];placement?:"inline"|"overlay"}) {
  const { t, i18n } = useTranslation();
 const number = new Intl.NumberFormat(i18n.resolvedLanguage);
 const [adding,setAdding]=useState(false),[createdIds,setCreatedIds]=useState<string[]>([]);
 const [board,setBoard]=useState(true),[includeCompleted,setIncludeCompleted]=useState(false);
 const membership=useCardMembership(folderId,createdIds);
 const completed=useCompletedCards(folderId,includeCompleted);
 const cards=[...membership.cards,...completed.cards].filter(c=>!c.archived).sort(compareStatusChange);
 const doneCount=cards.filter(card=>card.status==="done").length;
 const visibleCards=cards.filter(card=>includeCompleted||(card.status!=="done"&&(!board||card.status!=="cancelled")));
 const placeholder=membership.loading?(membership.error?null:<FrameLoading inline label={t("folders.cards.loading")}/>):undefined;

 return <div className="v3-folder-cards" data-testid="folder-card-section">
  {!board?<div className="v3-detail-section-head v3-folder-card-head"><h3>{t("folders.sections.cards")}</h3>{!membership.loading?<span>{t("folders.cards.shown", { total: number.format(visibleCards.length) })}</span>:null}
   <span className="v3-spacer"/>
   <CardCompletionFilter includeCompleted={includeCompleted} onChange={setIncludeCompleted} hiddenCount={doneCount}/>
   <div className="v3-card-actions">
    <DashboardIconCap size="small" label={board?t("folders.cards.list"):t("folders.sections.board")} onClick={()=>setBoard(value=>!value)}>{board?<List className="h-4 w-4"/>:<LayoutDashboard className="h-4 w-4"/>}</DashboardIconCap>
    <DashboardIconCap size="small" label={t("folders.cards.add")} onClick={()=>setAdding(true)}><Plus className="h-4 w-4"/></DashboardIconCap>
   </div></div>:null}
  {adding?<CardCreateDialog folders={folders} initialFolderId={folderId} onCreated={id=>setCreatedIds(ids=>[...ids,id])} onClose={()=>setAdding(false)}/>:null}
  {membership.error?<V3ErrorNotice message={t("folders.cards.loadError")} detail={membership.error} onRetry={membership.retry}/>:null}
  {board?<CardBoardWorkspace title={t("folders.cards.currentFolder")} cards={cards} completed={completed} boardPlaceholder={placeholder}
    actions={<DashboardIconCap size="small" label={t("folders.cards.list")} onClick={()=>setBoard(false)}><List className="h-4 w-4"/></DashboardIconCap>}
    draftAction={<DashboardIconCap size="small" label={t("folders.cards.new")} onClick={()=>setAdding(true)}><Plus className="h-4 w-4"/></DashboardIconCap>}
    renderCard={card=><PostItCard card={card} variant="compact"/>} completion={{includeCompleted,onChange:setIncludeCompleted}}/>
   :membership.loading?placeholder:<><PostItGrid>{visibleCards.filter(card=>card.status!=="done").map(card=><PostItCard key={card.id} card={card}/>)}</PostItGrid>
     {includeCompleted?<CompletedCardCollection browser={completed} renderCard={card=><PostItCard card={card}/>}/>:null}</>}
 </div>;
}
