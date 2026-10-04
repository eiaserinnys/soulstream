import { useState } from "react";
import { CardQueue } from "@seosoyoung/soul-ui/cards/CardQueue";
import {CARD_COLOR_KEYS, type CardColor, type CardRow, type CardStatus} from "@seosoyoung/soul-ui/cards/card-types";
import { PostItCardView, PostItGrid } from "./PostItCard";
import { reviewCard, reviewSession, reviewTitle } from "./components-review-fixtures";

/** The product paper and status picker, with local status and queue state only. */
export function PostItCardSamples({onOpen}:{onOpen(label:string):void}) {
  const [statuses,setStatuses]=useState<Record<string,CardStatus>>({});
  const [colors,setColors]=useState<Record<string,CardColor>>({});
  const [queueOrder,setQueueOrder]=useState(["postit-queued-a","postit-queued-b"]);
  const statusesToShow=["todo","blocked","running","review","done","cancelled"] as const;
  const cards=statusesToShow.map((status,index)=>({
    ...reviewCard,id:`postit-sample-${index}`,status:statuses[`postit-sample-${index}`]??status,
    color:colors[`postit-sample-${index}`]??CARD_COLOR_KEYS[index % CARD_COLOR_KEYS.length],
    title:index===0||index===3?reviewTitle:`포스트잇 ${status}`,blockedKind:status==="blocked"?"question" as const:null,
    assigneeKind:index===1?null:reviewCard.assigneeKind,
    latestActivity:{kind:index===0?"instruction" as const:"report" as const,format:"markdown" as const,
      body:"같은 카드 원문을 라벨 없이 표시합니다. 긴 제목과 본문이 있어도 푸터 위치와 카드 크기는 유지됩니다. ".repeat(4),createdAt:reviewCard.createdAt},
  }));
  const queuedSources=["postit-queued-a","postit-queued-b"].map((id,index)=>({...reviewCard,id,status:"queued" as const,
    color:colors[id]??CARD_COLOR_KEYS[(index+3) % CARD_COLOR_KEYS.length],
    title:index===0?"긴 제목의 대기 카드 순서 이동":"다음 대기 카드",queuePositionKey:index===0?"a":"b",
    latestActivity:{kind:"instruction" as const,format:"markdown" as const,body:"하단 상태 칩에서 메뉴를 열고 칩을 끌어 대기 순서를 바꿉니다. ".repeat(3),createdAt:reviewCard.createdAt},
  })).sort((a,b)=>queueOrder.indexOf(a.id)-queueOrder.indexOf(b.id)).filter(card=>(statuses[card.id]??card.status)==="queued");
  const renderCard=(card:CardRow,variant:"default"|"compact")=><PostItCardView card={{...card,status:statuses[card.id]??card.status}} variant={variant}
    activity={card.latestActivity??null} assignee={card.assigneeKind?reviewSession:undefined} onOpen={()=>onOpen("포스트잇 카드")}
    statusControl={{pending:false,load:async()=>({card:{...card,status:statuses[card.id]??card.status,color:colors[card.id]??card.color},reports:[],questions:[],sessions:[]}),
      change:async(_latest,status)=>{setStatuses(previous=>({...previous,[card.id]:status}));},
      changeColor:async(_latest,color)=>{setColors(previous=>({...previous,[card.id]:color}));}}}/>;
  return <div className="v3-postit-card-samples" data-testid="postit-card-samples">
    <div className="v3-postit-size-comparison">
      <div><p className="v3-components-label">기본 카드 · 제목과 본문</p><PostItGrid>{cards.map(card=><div key={card.id}>{renderCard(card,"default")}</div>)}</PostItGrid></div>
      <div><p className="v3-components-label">compact 카드 · 같은 본문</p><PostItGrid variant="compact">{cards.map(card=><div key={card.id}>{renderCard(card,"compact")}</div>)}</PostItGrid></div>
    </div>
    <section aria-label="대기 카드 순서 변경">
      <div className="v3-detail-section-head"><h3>대기 순서와 상태 메뉴</h3><span>칩을 끌면 순서를 바꿉니다</span></div>
      <PostItGrid><CardQueue layout="grid" activatorMode="status-chip" cards={queuedSources} onReorder={ids=>setQueueOrder([...ids])}
        renderRow={(card,_handle,activator)=><PostItCardView card={{...card,status:statuses[card.id]??card.status}} variant="default"
          activity={card.latestActivity??null} assignee={reviewSession} onOpen={()=>onOpen("대기 카드")}
          statusActivator={activator} statusControl={{pending:false,
            load:async()=>({card:{...card,status:statuses[card.id]??card.status,color:colors[card.id]??card.color},reports:[],questions:[],sessions:[]}),
            change:async(_latest,status)=>{setStatuses(previous=>({...previous,[card.id]:status}));},
            changeColor:async(_latest,color)=>{setColors(previous=>({...previous,[card.id]:color}));}}}/>}/>
      </PostItGrid>
    </section>
  </div>;
}
