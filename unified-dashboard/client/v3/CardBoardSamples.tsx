import { useState } from "react";
import { Button } from "@seosoyoung/soul-ui";
import type { CardStatus } from "@seosoyoung/soul-ui/cards/card-types";
import { CardBoard, boardColumns } from "./CardBoard";
import { CardCompletionFilter } from "./CardCompletionFilter";
import { PostItCardView, PostItGrid } from "./PostItCard";
import { reviewCard, reviewSession, reviewTitle } from "./components-review-fixtures";

/** The actual board and card, with fixture-only state and no operational writes. */
export function CardBoardSamples({onOpen}:{onOpen(label:string):void}) {
  const [scope,setScope]=useState<"folder"|"all">("folder");
  const [mode,setMode]=useState<"board"|"grid">("board");
  const [scenario,setScenario]=useState<"mixed"|"none"|"done">("mixed");
  const [includeCompleted,onChange]=useState(false);
  const [statuses,setStatuses]=useState<Record<string,CardStatus>>({});
  const cards=boardColumns.flatMap(({status},index)=>Array.from({length:index===0?4:1},(_,copy)=>({
    ...reviewCard,id:`board-${index}-${copy}`,status:statuses[`board-${index}-${copy}`]??(scenario==="done"?"done":status),
    title:index===0?reviewTitle:`${boardColumns[index].label} 카드`,blockedKind:status==="blocked"?"question" as const:null,
    latestActivity:{kind:index===0?"instruction" as const:"report" as const,format:"markdown" as const,
      body:"긴 본문이 있어도 카드와 열의 폭을 줄이지 않습니다. 최신 원문은 네 줄까지 읽고 상세에서 이어 봅니다. ".repeat(5),createdAt:reviewCard.createdAt},
  }))).filter(card=>scenario!=="none"||card.status!=="done");
  const doneCount=cards.filter(card=>card.status==="done").length;
  const renderCard=(card:typeof cards[number])=><PostItCardView card={card} activity={card.latestActivity} assignee={reviewSession}
    onOpen={()=>onOpen("보드 카드 상세")}
    statusControl={{pending:false,load:async()=>({card,reports:card.status==="todo"?[]:[{id:"sample-report",title:"보고",body:"보고",format:"markdown",createdAt:card.createdAt,sessionId:null}],
      questions:card.status==="blocked"?[{id:"sample-question",text:"질문",answer:null,options:null,askedAt:card.createdAt,answeredAt:null}]:[],sessions:[]}),
      change:async(_,status)=>setStatuses(previous=>({...previous,[card.id]:status}))}}/>;
  return <div className="v3-card-board-sample" data-testid="card-board-sample">
    <div className="v3-detail-section-head"><h3>{scope==="folder"?"현재 폴더 카드":"전체 카드"}</h3>
      {scope==="folder"?<CardCompletionFilter includeCompleted={includeCompleted} onChange={onChange} hiddenCount={doneCount}/>:null}
    </div>
    <div className="v3-detail-section-head">
      {(["folder","all"] as const).map(value=><Button key={value} size="sm" variant="ghost" aria-pressed={scope===value} onClick={()=>setScope(value)}>{value==="folder"?"현재 폴더":"전체"}</Button>)}
      {(["grid","board"] as const).map(value=><Button key={value} size="sm" variant="ghost" aria-pressed={mode===value} onClick={()=>setMode(value)}>{value==="grid"?"일반 보기":"보드"}</Button>)}
      {(["mixed","none","done"] as const).map(value=><Button key={value} size="sm" variant="ghost" aria-pressed={scenario===value} onClick={()=>{setScenario(value);setStatuses({});}}>{{mixed:"혼합",none:"완료 0개",done:"전부 완료"}[value]}</Button>)}
    </div>
    {mode==="board"?<CardBoard cards={cards} renderCard={renderCard} completion={scope==="folder"?{includeCompleted,onChange}:undefined}/>
      : <PostItGrid>{cards.filter(card=>scope==="all"||includeCompleted||card.status!=="done").map(card=><div key={card.id}>{renderCard(card)}</div>)}</PostItGrid>}
  </div>;
}
