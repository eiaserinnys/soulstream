import { useState } from "react";
import { Button, DashboardIconCap, Dialog, DialogPopup, Input, type CatalogFolder } from "@seosoyoung/soul-ui";
import { Check, LayoutDashboard, List, Plus, X } from "lucide-react";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import { cardMutationKey } from "@seosoyoung/soul-ui/cards/card-api";
import { PostItCard, PostItGrid } from "./PostItCard";
import { CardBoardWorkspace } from "./CardBoardWorkspace";
import { CardCompletionFilter } from "./CardCompletionFilter";
import { useCardMembership } from "./use-card-membership";
import { useCompletedCards } from "./use-completed-cards";
import { CompletedCardCollection } from "./CompletedCardCollection";
export function FolderCardSection({folderId,folders=[],placement="inline"}:{folderId:string;folders?:readonly CatalogFolder[];placement?:"inline"|"overlay"}) {
 const [adding,setAdding]=useState(false),[title,setTitle]=useState(""),[error,setError]=useState<string|null>(null),[pending,setPending]=useState(false),[createdIds,setCreatedIds]=useState<string[]>([]);
 const [board,setBoard]=useState(true),[includeCompleted,setIncludeCompleted]=useState(false);
 const membership=useCardMembership(folderId,createdIds);
 const completed=useCompletedCards(folderId,includeCompleted);
 const cards=[...membership.cards,...completed.cards].filter(c=>!c.archived).sort((a,b)=>a.positionKey<b.positionKey?-1:a.positionKey>b.positionKey?1:0);
 const doneCount=cards.filter(card=>card.status==="done").length;
 const visibleCards=cards.filter(card=>(!board||card.status!=="cancelled")&&(includeCompleted||card.status!=="done"));
 const add=async()=>{if(!title.trim()||pending)return;setPending(true);setError(null);try{const card=await useCardStore.getState().create({folderId,title:title.trim(),request:"",queue:false,idempotencyKey:cardMutationKey()});setCreatedIds(ids=>[...ids,card.id]);setTitle("");setAdding(false);}catch(e){setError(String(e));}finally{setPending(false);}};
 return <div className="v3-folder-cards" data-testid="folder-card-section">
  {!board?<div className="v3-detail-section-head v3-folder-card-head"><h3>카드</h3><span>{visibleCards.length}개 표시</span>
   <span className="v3-spacer"/>
   <CardCompletionFilter includeCompleted={includeCompleted} onChange={setIncludeCompleted} hiddenCount={doneCount}/>
   <div className="v3-card-actions">
    <DashboardIconCap size="small" label={board?"일반 보기":"보드"} onClick={()=>setBoard(value=>!value)}>{board?<List className="h-4 w-4"/>:<LayoutDashboard className="h-4 w-4"/>}</DashboardIconCap>
    <DashboardIconCap size="small" label="카드 추가" onClick={()=>setAdding(true)}><Plus className="h-4 w-4"/></DashboardIconCap>
   </div></div>:null}
  {adding?<Dialog open onOpenChange={open=>{if(!open)setAdding(false);}}><DialogPopup showCloseButton={false}><form className="v3-card-add" onSubmit={e=>{e.preventDefault();void add();}}><Input autoFocus aria-label="카드 제목" placeholder="카드 제목" value={title} onChange={e=>setTitle(e.target.value)} disabled={pending}/><DashboardIconCap label="카드 저장" type="submit" disabled={pending||!title.trim()}><Check className="h-4 w-4"/></DashboardIconCap><DashboardIconCap label="추가 취소" onClick={()=>setAdding(false)}><X className="h-4 w-4"/></DashboardIconCap></form>{error?<p role="alert" className="v3-card-error">{error}</p>:null}</DialogPopup></Dialog>:null}
  {error?<p role="alert" className="v3-card-error">{error}</p>:null}
  {membership.error?<p role="alert" className="v3-card-error">{membership.error}<Button size="sm" variant="ghost" onClick={membership.retry}>다시 불러오기</Button></p>:null}
  {board?<CardBoardWorkspace title="현재 폴더 카드" cards={cards} completed={completed}
    actions={<DashboardIconCap size="small" label="일반 보기" onClick={()=>setBoard(false)}><List className="h-4 w-4"/></DashboardIconCap>}
    draftAction={<Button size="sm" variant="ghost" aria-label="새 카드" onClick={()=>setAdding(true)}><Plus className="h-4 w-4"/>새 카드</Button>}
    renderCard={(card,handle,preview)=><PostItCard card={card} handle={handle} preview={preview} variant="compact"/>} completion={{includeCompleted,onChange:setIncludeCompleted}}/>
   :<><PostItGrid>{visibleCards.filter(card=>card.status!=="done").map(card=><PostItCard key={card.id} card={card}/>)}</PostItGrid>
     {includeCompleted?<CompletedCardCollection browser={completed} renderCard={card=><PostItCard card={card}/>}/>:null}</>}
 </div>;
}
