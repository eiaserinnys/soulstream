import { useState } from "react";
import { PostItCardView, PostItGrid } from "./PostItCard";
import { reviewCard, reviewSession, reviewTitle } from "./components-review-fixtures";

/** The product presentation, with local sample callbacks and no operational writes. */
export function PostItCardSamples({onOpen}:{onOpen(label:string):void}) {
  const [statuses,setStatuses]=useState<Record<string,import("@seosoyoung/soul-ui/cards/card-types").CardStatus>>({});
  return <PostItGrid>{(["todo","queued","blocked","running","review","done","cancelled"] as const).map((status,index)=>{
    const card={...reviewCard,id:`postit-sample-${index}`,status:statuses[`postit-sample-${index}`]??status,
      title:index===0||index===4?reviewTitle:`포스트잇 ${status}`,blockedKind:status==="blocked"?"question" as const:null,
      assigneeKind:index===2?null:reviewCard.assigneeKind};
    return <PostItCardView key={card.id} card={card} assignee={index===2?undefined:reviewSession}
      activity={index===1?null:{kind:index===0?"instruction":"report",format:"markdown",
        body:index===3?"짧은 실제 원문 미리보기입니다.":"제목과 본문이 길어도 같은 크기와 푸터 위치를 유지합니다. 원문을 요약하거나 새로운 사실을 만들지 않습니다. 네 줄 뒤의 내용은 카드 상세에서 확인합니다. ".repeat(3)}}
      onOpen={()=>onOpen("포스트잇 카드")}
      statusControl={{pending:false,
        load:async()=>({card,reports: index===1?[]:[{id:"local-report",title:"보고",body:"보고",format:"markdown",createdAt:card.createdAt,sessionId:null}],
          questions:status==="blocked"?[{id:"local-question",text:"샘플 질문",options:null,answer:null,askedAt:card.createdAt,answeredAt:null}]:[],sessions:[]}),
        change:async(_,next)=>{setStatuses(previous=>({...previous,[card.id]:next}));}}}
      completion={{pending:false,onComplete:()=>{setStatuses(previous=>({...previous,[card.id]:"done"}));onOpen("포스트잇 완료");}}}/>;
  })}</PostItGrid>;
}
