import { useEffect, useRef, useState, type CSSProperties } from "react";
import { DashboardIconCap } from "@seosoyoung/soul-ui";
import type { CardNow, CardNowHistoryEntry } from "@seosoyoung/soul-ui/cards/card-types";
import { ArrowLeft, ArrowRight } from "lucide-react";
import "./v3-card-check-items.css";

interface NowSlot { key:string; text:string; turn:CardNow["turn"]; ask:string|null; at:string }

export function CardNowPanel(props: {now?:CardNow|null;nowHistory?:readonly CardNowHistoryEntry[]|null;itemsCount:number;activeCount:number}) {
 return props.now?<CardNowPanelView {...props} now={props.now}/>:null;
}

function CardNowPanelView({now,nowHistory=[],itemsCount,activeCount}: {
 now:CardNow;nowHistory?:readonly CardNowHistoryEntry[]|null;itemsCount:number;activeCount:number;
}) {
 const panel=useRef<HTMLElement>(null),measure=useRef<HTMLDivElement>(null),frozenHeight=useRef<number|null>(null);
 const [selectedAt,setSelectedAt]=useState<string|null>(null);
 const [height,setHeight]=useState<number|null>(null);
 const stored=nowHistory??[];
 const slots:NowSlot[]=stored.length?[...stored.slice(0,-1).map((entry,index)=>({key:`${entry.at}:${index}`,text:entry.text,turn:entry.turn,ask:entry.ask,at:entry.at})),
  {key:`now:${now.updatedAt}`,text:now.text,turn:now.turn,ask:now.ask,at:now.updatedAt}]:
  [{key:`now:${now.updatedAt}`,text:now.text,turn:now.turn,ask:now.ask,at:now.updatedAt}];
 const index=selectedAt===null?slots.length-1:Math.max(0,slots.findIndex(slot=>slot.key===selectedAt));
 const latest=index===slots.length-1,entry=latest?slots.at(-1)!:slots[index];
 const hasNavigation=stored.length>1;
 const allChecked=itemsCount>0&&activeCount===0;
 const move=(next:number)=>{
  if(next<0||next>=slots.length)return;
  if(next===slots.length-1){frozenHeight.current=null;setHeight(null);setSelectedAt(null);return;}
  if(selectedAt===null){frozenHeight.current=panel.current?.getBoundingClientRect().height??null;setHeight(frozenHeight.current);}
  setSelectedAt(slots[next].key);
 };
 useEffect(()=>{
  if(selectedAt===null||!measure.current)return;
  const resize=new ResizeObserver(()=>{
   const next=measure.current?.getBoundingClientRect().height;
   if(next&&next!==frozenHeight.current){frozenHeight.current=next;setHeight(next);}
  });
  resize.observe(measure.current);
  return ()=>resize.disconnect();
 },[selectedAt,now,stored]);
 const style:CSSProperties|undefined=height?{height}:undefined;
 const current:NowSlot={key:`measure:${now.updatedAt}`,text:now.text,turn:now.turn,ask:now.ask,at:now.updatedAt};
 return <section ref={panel} className={`v3-card-now-panel${latest?"":" v3-card-now-panel--past"}`} style={style} data-testid="card-now-panel" data-now-view={latest?"current":"past"}>
  <NowPanelContents entry={entry} index={index} total={slots.length} latest={latest} hasNavigation={hasNavigation} allChecked={allChecked}
   onPrevious={()=>move(index-1)} onNext={()=>move(index+1)}/>
  <div ref={measure} className="v3-card-now-measure" aria-hidden="true">
   <NowPanelContents entry={current} index={slots.length-1} total={slots.length} latest hasNavigation={hasNavigation} allChecked={allChecked} onPrevious={()=>{}} onNext={()=>{}}/>
  </div>
 </section>;
}

function NowPanelContents({entry,index,total,latest,hasNavigation,allChecked,onPrevious,onNext}: {
 entry:NowSlot;index:number;total:number;latest:boolean;hasNavigation:boolean;allChecked:boolean;
 onPrevious():void;onNext():void;
}) {
 const dateLabel=formatUpdated(entry.at);
 return <>
  <div className="v3-card-now-header" data-has-navigation={hasNavigation?"true":undefined}>
   <div className="v3-card-now-meta"><strong>{latest?"지금":"지난 상황"}</strong>
    {hasNavigation?<span>{index+1}/{total}</span>:null}<time dateTime={entry.at}>{dateLabel}</time></div>
   {hasNavigation?<div className="v3-card-now-actions">
    <DashboardIconCap size="small" label="이전 상황" disabled={index===0} onClick={onPrevious}><ArrowLeft className="h-4 w-4"/></DashboardIconCap>
    <DashboardIconCap size="small" label="다음 상황" disabled={latest} onClick={onNext}><ArrowRight className="h-4 w-4"/></DashboardIconCap>
   </div>:null}
  </div>
  <p className="v3-card-now-text">{entry.text}</p>
  {latest?<div className={`v3-card-now-turn v3-card-now-turn--${entry.turn}`}>
   <strong>{allChecked?"모두 확인했습니다. 완료로 옮길까요?":turnLabel(entry.turn)}</strong>
   {allChecked||!entry.ask?null:<span>{entry.ask}</span>}
  </div>:<div className="v3-card-now-past-hint"><span>아래 확인 항목은 지금 상태입니다</span><button type="button" onClick={onNext}>최신으로</button></div>}
 </>;
}

function turnLabel(turn:CardNow["turn"]) { return turn==="agent"?"에이전트 차례":turn==="user"?"내 차례":"바깥 대기"; }
function formatUpdated(value:string) {
 const date=new Date(value);
 return Number.isNaN(date.getTime())?"":`${date.toLocaleTimeString("ko-KR",{hour:"2-digit",minute:"2-digit"})}에 고침`;
}
