import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { cardRequest } from "@seosoyoung/soul-ui/cards/card-api";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import type { CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { getV3InvalidationSnapshot, selectV3InvalidationKey, useV3InvalidationKey } from "./v3-live-invalidation-plane";
import { errorText } from "./v3-dashboard-utils";
const sources=["card","folder","catalog","replay"] as const;
const currentRevision=()=>selectV3InvalidationKey(getV3InvalidationSnapshot(),sources);

/** Authorized list membership is local to the web scope, independent of cached details. */
export function useCardMembership(folderId?:string,createdIds:readonly string[]=[]) {
  const cardRevision=useV3InvalidationKey(["card"]);
  const immediateRevision=useV3InvalidationKey(["folder","catalog","replay"]);
  const localRevision=useCardStore(state=>state.localRevision);
  const [membership,setMembership]=useState<{scope?:string;ids:string[]} | null>(null);
  const [error,setError]=useState<string|null>(null);
  const refresh=useRef<()=>void>(()=>{});
  const schedule=useRef<()=>void>(()=>{});
  useEffect(()=>{
    let active=true,running=false,dirty=false;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const unregister=folderId ? undefined : useCardStore.getState().registerGlobalList();
    setMembership(null);setError(null);
    const scheduleLoad=()=>{
      dirty=true;
      if(timer===undefined)timer=setTimeout(()=>{timer=undefined;void load();},500);
    };
    const load=async()=>{
      useCardStore.getState().observeReplay(getV3InvalidationSnapshot().sources.replay);
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
          if(dirty||started!==currentRevision()){
            if(!dirty)scheduleLoad();
            dirty=true;if(timer!==undefined)break;continue;
          }
          const store=useCardStore.getState();
          store.putCards(cards.filter(card=>!store.byId[card.id]||store.byId[card.id].version<=card.version));
          if(!folderId)store.reconcileGlobalList(cards);
          setMembership({scope:folderId,ids:[...new Set(cards.map(card=>card.id))]});setError(null);
        }catch(failure){
          if(!active)break;
          if(dirty||started!==currentRevision()){
            if(!dirty)scheduleLoad();
            dirty=true;if(timer!==undefined)break;continue;
          }
          if(!folderId)useCardStore.getState().reconcileGlobalList([]);
          setError(errorText(failure));
        }
      }
      running=false;
    };
    refresh.current=()=>{if(timer!==undefined){clearTimeout(timer);timer=undefined;}void load();};
    schedule.current=scheduleLoad;
    void load();
    return ()=>{active=false;if(timer!==undefined)clearTimeout(timer);unregister?.();};
  },[folderId]);
  const previousRevision=useRef({cardRevision,immediateRevision,localRevision});
  useEffect(()=>{
    const previous=previousRevision.current;
    previousRevision.current={cardRevision,immediateRevision,localRevision};
    if(previous.immediateRevision!==immediateRevision||previous.localRevision!==localRevision)refresh.current();
    else if(previous.cardRevision!==cardRevision)schedule.current();
  },[cardRevision,immediateRevision,localRevision]);
  const createdKey=createdIds.join("\0");
  useEffect(()=>{
    if(!createdKey)return;
    const ids=createdKey.split("\0");
    setMembership(current=>current&&current.scope===folderId?{...current,ids:[...new Set([...current.ids,...ids])]}:current);
    refresh.current();
  },[createdKey,folderId]);
  const ids=membership&&membership.scope===folderId?membership.ids:null;
  const cards=useCardStore(useShallow(state=>(ids??[]).map(id=>state.byId[id])));
  return {cards:cards.filter((card):card is CardRow=>Boolean(card)&&card.status!=="done"&&(!folderId||card.folderId===folderId)),
    loading:ids===null,error,retry:()=>refresh.current()};
}
