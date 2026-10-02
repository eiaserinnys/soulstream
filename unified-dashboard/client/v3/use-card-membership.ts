import { useEffect, useRef, useState } from "react";
import { cardRequest } from "@seosoyoung/soul-ui/cards/card-api";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import type { CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { getV3InvalidationSnapshot, selectV3InvalidationKey, useV3InvalidationKey } from "./v3-live-invalidation-plane";
const sources=["card","folder","catalog","replay"] as const;
const currentRevision=()=>selectV3InvalidationKey(getV3InvalidationSnapshot(),sources);

/** Authorized list membership is local to the web scope, independent of cached details. */
export function useCardMembership(folderId?:string,createdIds:readonly string[]=[]) {
  const revision=useV3InvalidationKey(sources);
  const byId=useCardStore(state=>state.byId);
  const [membership,setMembership]=useState<{scope?:string;ids:string[]} | null>(null);
  const [error,setError]=useState<string|null>(null);
  const refresh=useRef<()=>void>(()=>{});
  useEffect(()=>{
    let active=true,running=false,dirty=false;
    setMembership(null);setError(null);
    const load=async()=>{
      dirty=true;
      if(running)return;
      running=true;
      while(active&&dirty){
        dirty=false;const started=currentRevision();
        try {
          const path=`/api/cards?${new URLSearchParams({includeCompleted:"false",...(folderId?{folderId}:{})})}`;
          const {cards}=await cardRequest<{cards:CardRow[]}>(path);
          if(!active)break;
          // SSE during the request invalidates the response before it can overwrite new data.
          if(dirty||started!==currentRevision()){dirty=true;continue;}
          const store=useCardStore.getState();
          store.putCards(cards.filter(card=>!store.byId[card.id]||store.byId[card.id].version<=card.version));
          setMembership({scope:folderId,ids:[...new Set(cards.map(card=>card.id))]});setError(null);
        }catch(failure){
          if(!active)break;
          if(dirty||started!==currentRevision()){dirty=true;continue;}
          setError(String(failure));
        }
      }
      running=false;
    };
    refresh.current=()=>{void load();};
    void load();
    return ()=>{active=false;};
  },[folderId]);
  // Consecutive notifications coalesce into one request, with at most one follow-up in flight.
  const previousRevision=useRef(revision);
  useEffect(()=>{if(previousRevision.current!==revision){previousRevision.current=revision;refresh.current();}},[revision]);
  const createdKey=createdIds.join("\0");
  useEffect(()=>{
    if(!createdKey)return;
    const ids=createdKey.split("\0");
    setMembership(current=>current&&current.scope===folderId?{...current,ids:[...new Set([...current.ids,...ids])]}:current);
    refresh.current();
  },[createdKey,folderId]);
  const ids=membership&&membership.scope===folderId?membership.ids:null;
  return {cards:(ids??[]).map(id=>byId[id]).filter((card):card is CardRow=>Boolean(card)&&card.status!=="done"&&(!folderId||card.folderId===folderId)),
    loading:ids===null,error,retry:()=>refresh.current()};
}
