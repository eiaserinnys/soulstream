import { useState, type ReactNode } from "react";
import { Button, DashboardIconCap, Dialog, DialogPopup, Input, type CatalogFolder } from "@seosoyoung/soul-ui";
import { Check, LayoutDashboard, List, Plus, X } from "lucide-react";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import { cardMutationKey, groupCards } from "@seosoyoung/soul-ui/cards/card-api";
import { CardQueue } from "@seosoyoung/soul-ui/cards/CardQueue";
import { PostItCard, PostItGrid } from "./PostItCard";
import { useFolderPickerStars } from "./use-folder-picker-stars";
import { FolderPicker } from "./FolderPicker";
import { Popover, PopoverTrigger, PopoverPopup } from "@seosoyoung/soul-ui";
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
   draftAction={<Button variant="ghost" size="sm" aria-label="새 카드" onClick={()=>setAdding(true)}><Plus className="h-4 w-4"/>새 카드</Button>}/>
  {adding?<Dialog open onOpenChange={open=>{if(!open)setAdding(false);}}><DialogPopup showCloseButton={false}><CardCreateForm folders={folders} onCreated={id=>setCreatedIds(ids=>[...ids,id])} onClose={()=>setAdding(false)}/></DialogPopup></Dialog>:null}
 </div>;
 return <div className="v3-card-inbox"><div className="v3-detail-section-head v3-folder-card-head"><h3>전체 카드</h3><span className="v3-spacer"/><CardCompletionFilter includeCompleted={includeCompleted} onChange={setIncludeCompleted}/><div className="v3-card-actions">{actions}<DashboardIconCap size="small" label="보드" onClick={()=>setBoard(true)}><LayoutDashboard className="h-4 w-4"/></DashboardIconCap><DashboardIconCap size="small" label="카드 추가" onClick={()=>setAdding(true)}><Plus className="h-4 w-4"/></DashboardIconCap></div></div>{(["attention","running","queued"] as const).filter(group=>group==="attention"||groups[group].length>0).map(group=><section key={group} data-card-group={group}>
  <div className="v3-section-head"><h2>{{attention:"확인할 것",running:"진행 중",queued:"대기열"}[group]}</h2><span>{groups[group].length}</span></div>
  {group==="attention"&&adding?<CardCreateForm folders={folders} onClose={()=>setAdding(false)}/>:null}
  {group==="attention"&&empty?<div className="v3-card-inbox-empty"><strong>지금은 확인할 것이 없습니다</strong><span>아래에서 새 세션을 시작하세요.</span></div>:null}
  <PostItGrid>{group==="queued"?<CardQueue layout="grid" cards={groups.queued} renderRow={(card,handle)=><PostItCard card={card} handle={handle}/>}/>:groups[group].map(card=><PostItCard key={card.id} card={card}/>)}</PostItGrid>
 </section>)}{includeCompleted?<CompletedCardCollection browser={completed} renderCard={card=><PostItCard card={card}/>}/>:null}</div>;
}
function CardCreateForm({folders,onClose,onCreated}:{folders:readonly CatalogFolder[];onClose():void;onCreated?(id:string):void}) {
 const [title,setTitle]=useState(""),[request,setRequest]=useState(""),[folderId,setFolderId]=useState("");
 const [open,setOpen]=useState(false),[pending,setPending]=useState(false),[error,setError]=useState<string|null>(null);
 const stars=useFolderPickerStars(open,folders);
 const save=async()=>{if(!folderId||!title.trim()||pending)return;setPending(true);try{const saved=await useCardStore.getState().create({folderId,title:title.trim(),request:request.trim(),queue:false,idempotencyKey:cardMutationKey()});onCreated?.(saved.id);onClose();}catch(e){setError(String(e));}finally{setPending(false);}};
 return <form className="v3-card-create-form" onSubmit={e=>{e.preventDefault();void save();}}>
  <Input autoFocus aria-label="카드 제목" placeholder="카드 제목" value={title} onChange={e=>setTitle(e.target.value)} disabled={pending}/>
  <textarea aria-label="요청 원문" placeholder="요청 원문" rows={2} value={request} onChange={e=>setRequest(e.target.value)} disabled={pending}/>
  <div className="v3-card-add"><Popover open={open} onOpenChange={setOpen}><PopoverTrigger className="v3-card-handoff-chip rounded-full">{folders.find(f=>f.id===folderId)?.name??"폴더 선택"}</PopoverTrigger><PopoverPopup side="top" align="start" sideOffset={8} className="v3-shell v3-card-folder-picker"><FolderPicker folders={folders} starredFolderIds={stars.folderIds} selectedFolderId={folderId} disabledFolderIds={new Set(["claude","llm"])} pending={pending} onSelect={folder=>{setFolderId(folder.id);setOpen(false);}}/></PopoverPopup></Popover><span className="v3-spacer"/>
  <DashboardIconCap label="카드 저장" type="submit" disabled={pending||!title.trim()||!folderId}><Check className="h-4 w-4"/></DashboardIconCap><DashboardIconCap label="추가 취소" onClick={onClose}><X className="h-4 w-4"/></DashboardIconCap></div>{error?<p role="alert" className="v3-card-error">{error}</p>:null}
 </form>;
}
