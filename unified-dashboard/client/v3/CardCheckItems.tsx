import { useEffect, useRef, useState } from "react";
import type { CardCheckItem } from "@seosoyoung/soul-ui/cards/card-types";
import { CardImageViewer, type CardImageSelection } from "./CardImageViewer";
import { CardCheckItemRow } from "./CardCheckItemRow";
import { summarizeCardItems } from "./card-item-summary";
import "./v3-card-check-items.css";

export function CardCheckItems({items,pendingConfirmations={},onConfirmChange,onTargetItem,onOpenImage}: {
 items?:readonly CardCheckItem[]|null;pendingConfirmations?:Readonly<Record<number,boolean>>;
 onConfirmChange(itemId:number,confirmed:boolean):void|Promise<void>;onTargetItem(itemId:number):void;
 onOpenImage?(src:string,alt:string):void;
}) {
 const current=items??[];
 const initialized=useRef(current.length>0);
 const [initialConfirmedIds,setInitialConfirmedIds]=useState<ReadonlySet<number>>(()=>new Set(current.filter(item=>item.display==="confirmed").map(item=>item.id)));
 const [excludedFromGroup,setExcludedFromGroup]=useState<ReadonlySet<number>>(()=>new Set());
 const [expandedIds,setExpandedIds]=useState<ReadonlySet<number>>(()=>new Set(current.filter(isInitiallyExpanded).map(item=>item.id)));
 const [groupExpanded,setGroupExpanded]=useState(false);
 const [image,setImage]=useState<CardImageSelection|null>(null);
 const imageTrigger=useRef<HTMLElement|null>(null);
 const openImage=(src:string,alt:string)=>{
  imageTrigger.current=document.activeElement instanceof HTMLElement?document.activeElement:null;
  setImage({src,alt});
 };
 const closeImage=()=>{
  setImage(null);
  requestAnimationFrame(()=>imageTrigger.current?.focus({preventScroll:true}));
 };
 const summary=summarizeCardItems(current,pendingConfirmations);
 useEffect(()=>{
  if(initialized.current||current.length===0)return;
  initialized.current=true;
  setInitialConfirmedIds(new Set(current.filter(item=>item.display==="confirmed").map(item=>item.id)));
  setExpandedIds(new Set(current.filter(isInitiallyExpanded).map(item=>item.id)));
 },[current]);
 useEffect(()=>{
  const reopened=current.filter(item=>initialConfirmedIds.has(item.id)&&item.display!=="confirmed"&&!excludedFromGroup.has(item.id));
  if(!reopened.length)return;
  setExcludedFromGroup(existing=>new Set([...existing,...reopened.map(item=>item.id)]));
  setExpandedIds(existing=>new Set([...existing,...reopened.filter(isInitiallyExpanded).map(item=>item.id)]));
 },[current,initialConfirmedIds,excludedFromGroup]);
 const groupOnOpen=initialConfirmedIds.size>=3;
 const grouped=current.filter(item=>groupOnOpen&&initialConfirmedIds.has(item.id)&&item.display==="confirmed"
  &&pendingConfirmations[item.id]!==false&&!excludedFromGroup.has(item.id));
 const groupedIds=new Set(grouped.map(item=>item.id));
 const changeExpanded=(id:number)=>setExpandedIds(existing=>{const next=new Set(existing);if(next.has(id))next.delete(id);else next.add(id);return next;});
 const renderItem=(item:CardCheckItem)=><CardCheckItemRow key={item.id} item={item}
  checked={pendingConfirmations[item.id]??item.display==="confirmed"} pending={Object.prototype.hasOwnProperty.call(pendingConfirmations,item.id)}
  expanded={expandedIds.has(item.id)} onToggleExpanded={()=>changeExpanded(item.id)}
  onConfirmChange={confirmed=>{const wasExpanded=expandedIds.has(item.id);setExcludedFromGroup(existing=>new Set(existing).add(item.id));setExpandedIds(existing=>{
   const next=new Set(existing);if(confirmed)next.delete(item.id);else next.add(item.id);return next;
  });if(!confirmed)onTargetItem(item.id);void Promise.resolve(onConfirmChange(item.id,confirmed)).catch(()=>{
   setExpandedIds(existing=>{const next=new Set(existing);if(wasExpanded)next.add(item.id);else next.delete(item.id);return next;});
  });}}
  onTargetItem={()=>onTargetItem(item.id)} onOpenImage={(src,alt)=>onOpenImage?onOpenImage(src,alt):openImage(src,alt)}/>;
 return <>
  <div className="v3-card-check-items" data-testid="card-check-items" data-active-count={summary.activeCount} data-confirmed-count={summary.confirmedCount}>
   {current.length===0?<p className="v3-detail-empty">확인할 항목이 없습니다.</p>:<>
    {current.filter(item=>!groupedIds.has(item.id)).map(renderItem)}
    {grouped.length?<section className="v3-card-confirmed-group" data-testid="confirmed-items-group">
     <button type="button" aria-expanded={groupExpanded} onClick={()=>setGroupExpanded(value=>!value)}>
      <span>확인함 {grouped.length}개</span><span>{groupExpanded?"접기":"펼치기"}</span>
     </button>
     {groupExpanded?<div>{grouped.map(renderItem)}</div>:null}
    </section>:null}
   </>}
  </div>
  <CardImageViewer image={image} onClose={closeImage}/>
 </>;
}

function isInitiallyExpanded(item:CardCheckItem) {
 return item.display==="doing"||item.display==="reported"||item.display==="changed"||item.display==="fix"||item.display==="dropped"
  ||(item.display==="todo"&&Boolean(item.result||item.caveat||item.evidence.length));
}
