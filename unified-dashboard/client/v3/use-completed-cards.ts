import { useCallback, useEffect, useRef, useState } from "react";
import { cardRequest } from "@seosoyoung/soul-ui/cards/card-api";
import type { CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { completedBounds,localDate,type CompletedCardParams,type CompletedPeriod } from "@seosoyoung/soul-ui/cards/completed-cards";
import { useV3InvalidationKey } from "./v3-live-invalidation-plane";
type Page={cards:CardRow[];nextCursor:string|null};
export type CompletedPageLoader=(params:CompletedCardParams)=>Promise<Page>;
const loadPage:CompletedPageLoader=params=>cardRequest<Page>(`/api/cards?${new URLSearchParams({status:"done",...Object.fromEntries(Object.entries(params).filter(([,value])=>value!==undefined).map(([key,value])=>[key,String(value)]))})}`);
export function useCompletedCards(folderId:string|undefined,enabled:boolean,loader:CompletedPageLoader=loadPage) {
  const revision=useV3InvalidationKey(["card","folder","catalog","replay"]);
  const [period,setPeriod]=useState<CompletedPeriod>("7");
  const [start,setStart]=useState(()=>localDate(new Date(Date.now()-7*24*60*60*1000))),[end,setEnd]=useState(()=>localDate(new Date()));
  const [search,setSearch]=useState(""),[q,setQ]=useState("");
  useEffect(()=>{const timer=setTimeout(()=>setQ(search.trim()),250);return()=>clearTimeout(timer);},[search]);
  const invalidRange=period==="custom"&&!completedBounds(period,start,end,0);
  const key=JSON.stringify([folderId,period,start,end,q]),resetKey=`${key}:${revision}`;
  const [page,setPage]=useState<{key:string;cards:CardRow[];cursor:string|null}>({key:"",cards:[],cursor:null});
  const [loading,setLoading]=useState(false),[error,setError]=useState<string|null>(null);
  const generation=useRef(0),busy=useRef(false),cursor=useRef<string|null>(null);
  const pageParams=useRef<CompletedCardParams|null>(null);
  const fetchPage=useCallback(async(after?:string)=>{
    if(!enabled||invalidRange||busy.current)return;
    const current=generation.current;busy.current=true;setLoading(true);setError(null);
    const params=after?pageParams.current!:{folderId,...completedBounds(period,start,end,Date.now())!,q,limit:60};
    if(!after)pageParams.current=params;
    try {
      const result=await loader({...params,...(after?{cursor:after}:{})});
      if(current!==generation.current)return;
      cursor.current=result.nextCursor;
      setPage(previous=>({key,cursor:result.nextCursor,cards:[...new Map([...(after&&previous.key===key?previous.cards:[]),...result.cards].map(card=>[card.id,card])).values()]}));
    }catch(cause){if(current===generation.current)setError(cause instanceof Error?cause.message:String(cause));}
    finally{if(current===generation.current){busy.current=false;setLoading(false);}}
  },[enabled,invalidRange,folderId,period,start,end,q,key,loader]);
  useEffect(()=>{
    generation.current++;busy.current=false;cursor.current=null;setError(null);setLoading(false);
    if(enabled&&!invalidRange)void fetchPage();
    return()=>{generation.current++;};
  },[fetchPage,revision]);
  return {cards:enabled&&page.key===key?page.cards:[],loading,error,invalidRange,loaded:enabled&&!invalidRange&&page.key===key,resetKey,
    period,setPeriod,start,setStart,end,setEnd,search,setSearch,
    loadMore:()=>{if(cursor.current)void fetchPage(cursor.current);},retry:()=>void fetchPage(),hasMore:!!page.cursor};
}
export type CompletedBrowser=ReturnType<typeof useCompletedCards>;
