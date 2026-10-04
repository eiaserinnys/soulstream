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
 const byId=useCardStore(s=>s.byId);const groups=groupCards(Object.values(byId));
 const [adding,setAdding]=useState(false);
 const [board,setBoard]=useState(initialBoard);
 const [includeCompleted,setIncludeCompleted]=useState(false);
 const completed=useCompletedCards(undefined,includeCompleted);
 const [createdIds,setCreatedIds]=useState<string[]>([]);
 const empty=!groups.attention.length&&!groups.running.length&&!groups.queued.length;
 if(board)return <div className="v3-card-inbox" data-card-scope="all">
  <CardInboxBoard createdIds={createdIds} completion={{includeCompleted,onChange:setIncludeCompleted}} completed={completed}
   actions={<>{actions}<DashboardIconCap size="small" label="일반 보기" onClick={()=>setBoard(false)}><List className="h-4 w-4"/></DashboardIconCap></>}
   draftAction={<DashboardIconCap size="small" label="새 카드" onClick={()=>setAdding(true)}><Plus className="h-4 w-4"/></DashboardIconCap>}/>
  {adding?<CardCreateDialog folders={folders} onCreated={id=>setCreatedIds(ids=>[...ids,id])} onClose={()=>setAdding(false)}/>:null}
 </div>;
 return <div className="v3-card-inbox">{adding?<CardCreateDialog folders={folders} onClose={()=>setAdding(false)}/>:null}<div className="v3-detail-section-head v3-folder-card-head"><h3>전체 카드</h3><span className="v3-spacer"/><CardCompletionFilter includeCompleted={includeCompleted} onChange={setIncludeCompleted}/><div className="v3-card-actions">{actions}<DashboardIconCap size="small" label="보드" onClick={()=>setBoard(true)}><LayoutDashboard className="h-4 w-4"/></DashboardIconCap><DashboardIconCap size="small" label="카드 추가" onClick={()=>setAdding(true)}><Plus className="h-4 w-4"/></DashboardIconCap></div></div>{(["attention","running","queued"] as const).filter(group=>group==="attention"||groups[group].length>0).map(group=><section key={group} data-card-group={group}>
  <div className="v3-section-head"><h2>{{attention:"확인할 것",running:"진행 중",queued:"대기열"}[group]}</h2><span>{groups[group].length}</span></div>

  {group==="attention"&&empty?<div className="v3-card-inbox-empty"><strong>지금은 확인할 것이 없습니다</strong><span>아래에서 새 세션을 시작하세요.</span></div>:null}
  <PostItGrid>{group==="queued"?<CardQueue layout="grid" activatorMode="status-chip" cards={groups.queued} renderRow={(card,_handle,activator)=><PostItCard card={card} statusActivator={activator}/>}/>:groups[group].map(card=><PostItCard key={card.id} card={card}/>)}</PostItGrid>
 </section>)}{includeCompleted?<CompletedCardCollection browser={completed} renderCard={card=><PostItCard card={card}/>}/>:null}</div>;
}
