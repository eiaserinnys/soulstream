import { PostItCardView, PostItGrid } from "./PostItCard";
import { CardDetailPane } from "./CardDetailPane";
import { reviewCard, reviewDetail, reviewFolders, reviewSession } from "./components-review-fixtures";
import type { CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { CardDispatchTab } from "../components/CardDispatchTab";
import { createDialoguesApi } from "./dialogues-api";
import { useMemo, useState } from "react";

const dependency = (number:number,status:CardRow["status"],met=false) => ({id:`sample-dependency-${number}`,number,title:`선행 카드 ${number}`,status,archived:false,met});
const cards:CardRow[] = [
 {...reviewCard,id:"sample-dependency-wait",status:"queued",title:"선행 카드를 기다리는 작업",dependsOn:[dependency(12,"running")]},
 {...reviewCard,id:"sample-dependency-stop",status:"queued",title:"선행 카드가 취소된 작업",dependsOn:[dependency(15,"cancelled")]},
];

export function CardDependencySamples() {
 const [statuses,setStatuses]=useState<Record<string,CardRow["status"]>>({});
 const api=useMemo(()=>{
  const fixture=createDialoguesApi().config;
  let settings={version:1,nodeConcurrency:{default:0},reviewMeetsDependency:true,startReleasedDependents:true};
  const cardsApi=(async(path:string,method?:string,body?:object)=>{
   if(path==="/api/settings/card-dispatch"){
    if(method==="PUT")settings={...settings,...body as typeof settings,version:settings.version+1};
    return {settings};
   }
   return fixture.cards(path,method,body);
  }) as typeof fixture.cards;
  return {cards:cardsApi,orchestration:fixture.orchestration};
 },[]);
 return <div data-testid="card-dependency-samples" className="space-y-4">
  <PostItGrid>{cards.map(source=>{const card={...source,status:statuses[source.id]??source.status};return <PostItCardView key={card.id} card={card} activity={card.latestActivity??null} assignee={reviewSession} onOpen={()=>{}}
   statusControl={{pending:false,load:async()=>({...reviewDetail,card}),change:async(_card,status)=>{setStatuses(current=>({...current,[card.id]:status}));}}}/>;})}</PostItGrid>
  <CardDetailPane cardId={cards[0]!.id} folders={reviewFolders} sampleDetail={{...reviewDetail,card:{...cards[0]!,dependsOn:[dependency(11,"done",true),dependency(12,"running"),dependency(15,"cancelled")]}}} onClose={()=>{}} onOpenSession={()=>{}}/>
  <CardDispatchTab api={api.cards} orchestration={api.orchestration}/>
 </div>;
}
