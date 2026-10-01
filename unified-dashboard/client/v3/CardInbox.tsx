import { useState } from "react";
import { DashboardIconCap, Input, type CatalogFolder } from "@seosoyoung/soul-ui";
import { Check, Plus, X } from "lucide-react";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import { cardMutationKey, groupCards } from "@seosoyoung/soul-ui/cards/card-api";
import { CardQueue } from "@seosoyoung/soul-ui/cards/CardQueue";
import { PostItCard, PostItGrid } from "./PostItCard";
import { useFolderPickerStars } from "./use-folder-picker-stars";
import { FolderPicker } from "./FolderPicker";
import { Popover, PopoverTrigger, PopoverPopup } from "@seosoyoung/soul-ui";
export function CardInbox({folders}:{folders:readonly CatalogFolder[]}) {
 const byId=useCardStore(s=>s.byId);const groups=groupCards(Object.values(byId));
 const [adding,setAdding]=useState(false);
 const empty=!groups.attention.length&&!groups.running.length&&!groups.queued.length;
 return <div className="v3-card-inbox">{(["attention","running","queued"] as const).filter(group=>group==="attention"||groups[group].length>0).map(group=><section key={group} data-card-group={group}>
  <div className="v3-section-head"><h2>{{attention:"확인할 것",running:"진행 중",queued:"대기열"}[group]}</h2><span>{groups[group].length}</span>{group==="attention"?<DashboardIconCap size="small" label="카드 추가" onClick={()=>setAdding(true)}><Plus className="h-4 w-4"/></DashboardIconCap>:null}</div>
  {group==="attention"&&adding?<CardCreateForm folders={folders} onClose={()=>setAdding(false)}/>:null}
  {group==="attention"&&empty?<div className="v3-card-inbox-empty"><strong>지금은 확인할 것이 없습니다</strong><span>아래에서 새 세션을 시작하세요.</span></div>:null}
  <PostItGrid>{group==="queued"?<CardQueue layout="grid" cards={groups.queued} renderRow={(card,handle)=><PostItCard card={card} handle={handle}/>}/>:groups[group].map(card=><PostItCard key={card.id} card={card}/>)}</PostItGrid>
 </section>)}</div>;
}
function CardCreateForm({folders,onClose}:{folders:readonly CatalogFolder[];onClose():void}) {
 const [title,setTitle]=useState(""),[request,setRequest]=useState(""),[folderId,setFolderId]=useState("");
 const [open,setOpen]=useState(false),[pending,setPending]=useState(false),[error,setError]=useState<string|null>(null);
 const stars=useFolderPickerStars(open,folders);
 const save=async()=>{if(!folderId||!title.trim()||pending)return;setPending(true);try{await useCardStore.getState().create({folderId,title:title.trim(),request:request.trim(),queue:false,idempotencyKey:cardMutationKey()});onClose();}catch(e){setError(String(e));}finally{setPending(false);}};
 return <form className="v3-card-create-form" onSubmit={e=>{e.preventDefault();void save();}}>
  <Input autoFocus aria-label="카드 제목" placeholder="카드 제목" value={title} onChange={e=>setTitle(e.target.value)} disabled={pending}/>
  <textarea aria-label="요청 원문" placeholder="요청 원문" rows={2} value={request} onChange={e=>setRequest(e.target.value)} disabled={pending}/>
  <div className="v3-card-add"><Popover open={open} onOpenChange={setOpen}><PopoverTrigger className="v3-card-handoff-chip rounded-full">{folders.find(f=>f.id===folderId)?.name??"폴더 선택"}</PopoverTrigger><PopoverPopup side="top" align="start" sideOffset={8} className="v3-shell v3-card-folder-picker"><FolderPicker folders={folders} starredFolderIds={stars.folderIds} selectedFolderId={folderId} disabledFolderIds={new Set(["claude","llm"])} pending={pending} onSelect={folder=>{setFolderId(folder.id);setOpen(false);}}/></PopoverPopup></Popover><span className="v3-spacer"/>
  <DashboardIconCap label="카드 저장" type="submit" disabled={pending||!title.trim()||!folderId}><Check className="h-4 w-4"/></DashboardIconCap><DashboardIconCap label="추가 취소" onClick={onClose}><X className="h-4 w-4"/></DashboardIconCap></div>{error?<p role="alert" className="v3-card-error">{error}</p>:null}
 </form>;
}
