import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import { cardRequest } from "@seosoyoung/soul-ui/cards/card-api";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import type { CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { completedBounds,localDate,type CompletedCardParams,type CompletedPeriod } from "@seosoyoung/soul-ui/cards/completed-cards";
import { useV3InvalidationKey } from "./v3-live-invalidation-plane";
type Page={cards:CardRow[];nextCursor:string|null};
type Accumulated={cards:CardRow[];cursor:string|null};
export type CompletedPageLoader=(params:CompletedCardParams)=>Promise<Page>;
const loadPage=(params:CompletedCardParams,t:ReturnType<typeof useTranslation>["t"])=>cardRequest<Page>(`/api/cards?${new URLSearchParams({status:"done",...Object.fromEntries(Object.entries(params).filter(([,value])=>value!==undefined).map(([key,value])=>[key,String(value)]))})}`,"GET",undefined,undefined,t);

export function mergeCompletedRefresh(first:Page,previous:Accumulated):Accumulated {
  if(!first.nextCursor)return {cards:first.cards,cursor:null};
  const last=first.cards.at(-1)?.completedAt;
  const ids=new Set(first.cards.map(card=>card.id));
  const tail=previous.cards.filter(card=>!ids.has(card.id)&&(!card.completedAt||!last||card.completedAt<=last));
  return {cards:[...first.cards,...tail],cursor:tail.length?previous.cursor:first.nextCursor};
}

export function useCompletedCards(folderId:string|undefined,enabled:boolean,loader?:CompletedPageLoader) {
  const {t}=useTranslation();
  const cardRevision=useV3InvalidationKey(["card"]);
  const immediateRevision=useV3InvalidationKey(["folder","catalog","replay"]);
  const localRevision=useCardStore(state=>state.localRevision);
  const [period,setPeriod]=useState<CompletedPeriod>("7");
  const [start,setStart]=useState(()=>localDate(new Date(Date.now()-7*24*60*60*1000))),[end,setEnd]=useState(()=>localDate(new Date()));
  const [search,setSearch]=useState(""),[q,setQ]=useState("");
  useEffect(()=>{const timer=setTimeout(()=>setQ(search.trim()),250);return()=>clearTimeout(timer);},[search]);
  const invalidRange=period==="custom"&&!completedBounds(period,start,end,0);
  const key=JSON.stringify([folderId,period,start,end,q]);
  const [page,setPage]=useState<{key:string;cards:CardRow[];cursor:string|null}>({key:"",cards:[],cursor:null});
  const [loading,setLoading]=useState(false),[error,setError]=useState<string|null>(null);
  const busy=useRef(false),queued=useRef<(()=>void)|null>(null);
  const refresh=useRef<()=>void>(()=>{}),more=useRef<()=>void>(()=>{}),retry=useRef<()=>void>(()=>{});
  const schedule=useRef<()=>void>(()=>{});
  useEffect(()=>{
    let active=true,dirty=false,loaded=false;
    let timer:ReturnType<typeof setTimeout>|undefined;
    let accumulated:Accumulated={cards:[],cursor:null};
    let params:CompletedCardParams|null=null;
    setPage({key:"",cards:[],cursor:null});setError(null);setLoading(false);
    const load=async(mode:"initial"|"refresh"|"more")=>{
      if(!active||!enabled||invalidRange)return;
      if(busy.current){if(mode==="refresh")dirty=true;else if(mode==="initial")queued.current=()=>void load("initial");return;}
      if(mode==="refresh")dirty=false;
      busy.current=true;setLoading(true);setError(null);
      const after=mode==="more"?accumulated.cursor:null;
      const request=mode==="more"?params!:{folderId,...completedBounds(period,start,end,Date.now())!,q,limit:60};
      if(mode!=="more")params=request;
      try {
        const pageParams={...request,...(after?{cursor:after}:{})};
        const result=await (loader?loader(pageParams):loadPage(pageParams,t));
        if(!active)return;
        accumulated=mode==="refresh"?mergeCompletedRefresh(result,accumulated):mode==="more"
          ?{cards:[...new Map([...accumulated.cards,...result.cards].map(card=>[card.id,card])).values()],cursor:result.nextCursor}
          :{cards:result.cards,cursor:result.nextCursor};
        loaded=true;setPage({key,...accumulated});
      }catch(cause){if(active)setError(cause instanceof Error?cause.message:String(cause));}
      finally {
        busy.current=false;
        if(active){setLoading(false);if(dirty&&timer===undefined)void load("refresh");}
        else {const next=queued.current;queued.current=null;next?.();}
      }
    };
    refresh.current=()=>{if(timer!==undefined){clearTimeout(timer);timer=undefined;}void load("refresh");};
    schedule.current=()=>{
      if(!enabled||invalidRange)return;
      dirty=true;
      if(timer===undefined)timer=setTimeout(()=>{timer=undefined;void load("refresh");},500);
    };
    more.current=()=>{if(accumulated.cursor)void load("more");};
    retry.current=()=>void load(loaded?"refresh":"initial");
    if(enabled&&!invalidRange)void load("initial");
    return()=>{active=false;queued.current=null;if(timer!==undefined)clearTimeout(timer);};
  },[key,enabled,invalidRange,folderId,period,start,end,q,loader,t]);
  const previousRevision=useRef({cardRevision,immediateRevision,localRevision});
  useEffect(()=>{
    const previous=previousRevision.current;
    previousRevision.current={cardRevision,immediateRevision,localRevision};
    if(previous.immediateRevision!==immediateRevision||previous.localRevision!==localRevision)refresh.current();
    else if(previous.cardRevision!==cardRevision)schedule.current();
  },[cardRevision,immediateRevision,localRevision]);
  return {cards:enabled&&page.key===key?page.cards:[],loading,error,invalidRange,loaded:enabled&&!invalidRange&&page.key===key,resetKey:key,
    period,setPeriod,start,setStart,end,setEnd,search,setSearch,
    loadMore:()=>more.current(),retry:()=>retry.current(),hasMore:enabled&&page.key===key&&!!page.cursor};
}
export type CompletedBrowser=ReturnType<typeof useCompletedCards>;
