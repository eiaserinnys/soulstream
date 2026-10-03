import {CardCreateDialog} from "./CardCreateDialog";
import { useState } from "react";
import { Button, DashboardIconCap, type CatalogFolder } from "@seosoyoung/soul-ui";
import { LayoutDashboard, List, Plus } from "lucide-react";
import { PostItCard, PostItGrid } from "./PostItCard";
import { CardBoardWorkspace } from "./CardBoardWorkspace";
import { CardCompletionFilter } from "./CardCompletionFilter";
import { useCardMembership } from "./use-card-membership";
import { useCompletedCards } from "./use-completed-cards";
import { CompletedCardCollection } from "./CompletedCardCollection";
export function FolderCardSection({folderId,folders=[],placement="inline"}:{folderId:string;folders?:readonly CatalogFolder[];placement?:"inline"|"overlay"}) {
 const [adding,setAdding]=useState(false),[createdIds,setCreatedIds]=useState<string[]>([]);
 const [board,setBoard]=useState(true),[includeCompleted,setIncludeCompleted]=useState(false);
 const membership=useCardMembership(folderId,createdIds);
 const completed=useCompletedCards(folderId,includeCompleted);
 const cards=[...membership.cards,...completed.cards].filter(c=>!c.archived).sort((a,b)=>a.positionKey<b.positionKey?-1:a.positionKey>b.positionKey?1:0);
 const doneCount=cards.filter(card=>card.status==="done").length;
 const visibleCards=cards.filter(card=>(!board||card.status!=="cancelled")&&(includeCompleted||card.status!=="done"));

 return <div className="v3-folder-cards" data-testid="folder-card-section">
  {!board?<div className="v3-detail-section-head v3-folder-card-head"><h3>카드</h3><span>{visibleCards.length}개 표시</span>
   <span className="v3-spacer"/>
   <CardCompletionFilter includeCompleted={includeCompleted} onChange={setIncludeCompleted} hiddenCount={doneCount}/>
   <div className="v3-card-actions">
    <DashboardIconCap size="small" label={board?"일반 보기":"보드"} onClick={()=>setBoard(value=>!value)}>{board?<List className="h-4 w-4"/>:<LayoutDashboard className="h-4 w-4"/>}</DashboardIconCap>
    <DashboardIconCap size="small" label="카드 추가" onClick={()=>setAdding(true)}><Plus className="h-4 w-4"/></DashboardIconCap>
   </div></div>:null}
  {adding?<CardCreateDialog folders={folders} initialFolderId={folderId} onCreated={id=>setCreatedIds(ids=>[...ids,id])} onClose={()=>setAdding(false)}/>:null}
  {membership.error?<p role="alert" className="v3-card-error">{membership.error}<Button size="sm" variant="ghost" onClick={membership.retry}>다시 불러오기</Button></p>:null}
  {board?<CardBoardWorkspace title="현재 폴더 카드" cards={cards} completed={completed}
    actions={<DashboardIconCap size="small" label="일반 보기" onClick={()=>setBoard(false)}><List className="h-4 w-4"/></DashboardIconCap>}
    draftAction={<DashboardIconCap size="small" label="새 카드" onClick={()=>setAdding(true)}><Plus className="h-4 w-4"/></DashboardIconCap>}
    renderCard={(card,handle,preview)=><PostItCard card={card} handle={handle} preview={preview} variant="compact"/>} completion={{includeCompleted,onChange:setIncludeCompleted}}/>
   :<><PostItGrid>{visibleCards.filter(card=>card.status!=="done").map(card=><PostItCard key={card.id} card={card}/>)}</PostItGrid>
     {includeCompleted?<CompletedCardCollection browser={completed} renderCard={card=><PostItCard card={card}/>}/>:null}</>}
 </div>;
}
