import { useEffect, useState } from "react";
import { DashboardIconCap, Input, type CatalogFolder } from "@seosoyoung/soul-ui";
import { Check, LayoutDashboard, List, Plus, X } from "lucide-react";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import { cardMutationKey } from "@seosoyoung/soul-ui/cards/card-api";
import { PostItCard, PostItGrid } from "./PostItCard";
import { CardBoard } from "./CardBoard";
import { CardCompletionFilter } from "./CardCompletionFilter";
export function FolderCardSection({folderId,folders=[],placement="inline"}:{folderId:string;folders?:readonly CatalogFolder[];placement?:"inline"|"overlay"}) {
 const byId=useCardStore(s=>s.byId);const [adding,setAdding]=useState(false),[title,setTitle]=useState(""),[error,setError]=useState<string|null>(null),[pending,setPending]=useState(false);
 const [board,setBoard]=useState(false),[includeCompleted,setIncludeCompleted]=useState(false);
 useEffect(()=>{void useCardStore.getState().loadFolder(folderId).catch(e=>setError(String(e)));},[folderId]);
 const cards=Object.values(byId).filter(c=>c.folderId===folderId&&!c.archived).sort((a,b)=>a.positionKey<b.positionKey?-1:a.positionKey>b.positionKey?1:0);
 const doneCount=cards.filter(card=>card.status==="done").length;
 const visibleCards=cards.filter(card=>(!board||card.status!=="cancelled")&&(includeCompleted||card.status!=="done"));
 const add=async()=>{if(!title.trim()||pending)return;setPending(true);setError(null);try{await useCardStore.getState().create({folderId,title:title.trim(),request:"",queue:false,idempotencyKey:cardMutationKey()});setTitle("");setAdding(false);}catch(e){setError(String(e));}finally{setPending(false);}};
 return <div className="v3-folder-cards" data-testid="folder-card-section">
  <div className="v3-detail-section-head v3-folder-card-head"><h3>{board?"현재 폴더 카드":"카드"}</h3><span>{visibleCards.length}개</span>
   <CardCompletionFilter includeCompleted={includeCompleted} onChange={setIncludeCompleted} hiddenCount={doneCount}/>
   <span className="v3-spacer"/>
   <DashboardIconCap size="small" label={board?"일반 보기":"보드"} onClick={()=>setBoard(value=>!value)}>{board?<List className="h-4 w-4"/>:<LayoutDashboard className="h-4 w-4"/>}</DashboardIconCap>
   <DashboardIconCap size="small" label="카드 추가" onClick={()=>setAdding(true)}><Plus className="h-4 w-4"/></DashboardIconCap></div>
  {adding?<form className="v3-card-add" onSubmit={e=>{e.preventDefault();void add();}}><Input autoFocus aria-label="카드 제목" placeholder="카드 제목" value={title} onChange={e=>setTitle(e.target.value)} disabled={pending}/><DashboardIconCap label="카드 저장" type="submit" disabled={pending||!title.trim()}><Check className="h-4 w-4"/></DashboardIconCap><DashboardIconCap label="추가 취소" onClick={()=>setAdding(false)}><X className="h-4 w-4"/></DashboardIconCap></form>:null}
  {error?<p role="alert" className="v3-card-error">{error}</p>:null}
  {board?<CardBoard cards={cards} renderCard={card=><PostItCard card={card}/>} completion={{includeCompleted,onChange:setIncludeCompleted}}/>
   :<PostItGrid>{visibleCards.map(card=><PostItCard key={card.id} card={card}/>)}</PostItGrid>}
 </div>;
}
