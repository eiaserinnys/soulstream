import { useCallback,useMemo,useState, type ReactNode } from "react";
import { Button } from "@seosoyoung/soul-ui";
import type { CardStatus } from "@seosoyoung/soul-ui/cards/card-types";
import { boardColumns } from "./CardBoard";
import { CardBoardWorkspace } from "./CardBoardWorkspace";
import { CardCompletionFilter } from "./CardCompletionFilter";
import { PostItCardView, PostItGrid, type PostItVariant } from "./PostItCard";
import { reviewCard, reviewDetail, reviewFolders, reviewSession, reviewTitle } from "./components-review-fixtures";
import { CardWorkspace } from "./CardWorkspace";
import { useMobilePlannerMode } from "./MobilePlannerTabs";
import { useCompletedCards,type CompletedPageLoader } from "./use-completed-cards";
import { CompletedCardCollection } from "./CompletedCardCollection";

/** The actual board and card, with fixture-only state and no operational writes. */
export function CardBoardSamples({onOpen}:{onOpen(label:string):void}) {
  const [scope,setScope]=useState<"folder"|"all">("folder");
  const [mode,setMode]=useState<"board"|"grid">("board");
  const [scenario,setScenario]=useState<"mixed"|"none"|"done">("mixed");
  const [includeCompleted,onChange]=useState(false);
  const [statuses,setStatuses]=useState<Record<string,CardStatus>>({});
  const [conversation,setConversation]=useState<"short"|"long">("short");
  const [selected,setSelected]=useState<string|null>(null);
  const mobileMode=useMobilePlannerMode();
  const cards=useMemo(()=>boardColumns.flatMap(({status},index)=>Array.from({length:index===0?4:status==='done'?1000:1},(_,copy)=>({
    ...reviewCard,id:`board-${index}-${copy}`,status:statuses[`board-${index}-${copy}`]??(scenario==="done"?"done":status),
    title:index===0?reviewTitle:`${boardColumns[index].label} 카드`,blockedKind:status==="blocked"?"question" as const:null,
    completedAt:new Date(Date.now()-copy*10*60*1000).toISOString(),
    latestActivity:{kind:index===0?"instruction" as const:"report" as const,format:"markdown" as const,
      body:"긴 본문이 있어도 카드와 열의 폭을 줄이지 않습니다. 최신 원문은 네 줄까지 읽고 상세에서 이어 봅니다. ".repeat(5),createdAt:reviewCard.createdAt},
  }))).filter(card=>scenario!=="none"||card.status!=="done"),[scenario,statuses]);
  const loader=useCallback<CompletedPageLoader>(async params=>{
    const result=cards.filter(card=>card.status==='done'&&(!params.completedFrom||card.completedAt>=params.completedFrom)&&(!params.completedBefore||card.completedAt<params.completedBefore)&&(`${card.title} ${card.request}`.toLocaleLowerCase().includes((params.q??'').toLocaleLowerCase()))).sort((a,b)=>b.completedAt.localeCompare(a.completedAt)||b.id.localeCompare(a.id));
    const offset=Number(params.cursor??0),limit=params.limit??60;
    return {cards:result.slice(offset,offset+limit),nextCursor:offset+limit<result.length?String(offset+limit):null};
  },[cards]);
  const completed=useCompletedCards(undefined,includeCompleted,loader);
  const visibleCards=[...cards.filter(card=>card.status!=='done'),...completed.cards];
  const doneCount=cards.filter(card=>card.status==="done").length;
  const renderCard=(card:typeof cards[number],variant:PostItVariant="compact",handle?:ReactNode,preview=false)=><PostItCardView card={card} variant={variant} activity={card.latestActivity} handle={handle} assignee={reviewSession}
    onOpen={()=>setSelected(card.id)}
    completion={preview?undefined:{pending:false,onComplete:()=>setStatuses(previous=>({...previous,[card.id]:"done"}))}}
    statusControl={preview?undefined:{pending:false,load:async()=>({card,reports:card.status==="todo"?[]:[{id:"sample-report",title:"보고",body:"보고",format:"markdown",createdAt:card.createdAt,sessionId:null}],
      questions:card.status==="blocked"?[{id:"sample-question",text:"질문",answer:null,options:null,askedAt:card.createdAt,answeredAt:null}]:[],sessions:[]}),
      change:async(_,status)=>setStatuses(previous=>({...previous,[card.id]:status}))}}/>;
  const comparison={...cards[0],id:"board-size-comparison",status:statuses["board-size-comparison"]??"review" as const};
  const selectedCard=selected===comparison.id?comparison:cards.find(card=>card.id===selected);
  return <div className="v3-card-board-sample" data-testid="card-board-sample">
    <div className="v3-postit-size-comparison" data-testid="postit-size-comparison">
      <div><p className="v3-components-label">기본 · 같은 제목과 원문</p>{renderCard(comparison,"default")}</div>
      <div><p className="v3-components-label">보드 compact · 같은 제목과 원문</p>{renderCard(comparison,"compact")}</div>
    </div>
    <div className="v3-detail-section-head"><h3>{scope==="folder"?"현재 폴더 카드":"전체 카드"}</h3>
      <span className="v3-spacer"/><CardCompletionFilter includeCompleted={includeCompleted} onChange={onChange}/>
    </div>
    <div className="v3-detail-section-head">
      {(["folder","all"] as const).map(value=><Button key={value} size="sm" variant="ghost" aria-pressed={scope===value} onClick={()=>setScope(value)}>{value==="folder"?"현재 폴더":"전체"}</Button>)}
      {(["grid","board"] as const).map(value=><Button key={value} size="sm" variant="ghost" aria-pressed={mode===value} onClick={()=>setMode(value)}>{value==="grid"?"일반 보기":"보드"}</Button>)}
      {(["mixed","none","done"] as const).map(value=><Button key={value} size="sm" variant="ghost" aria-pressed={scenario===value} onClick={()=>{setScenario(value);setStatuses({});}}>{{mixed:"혼합",none:"완료 0개",done:"전부 완료"}[value]}</Button>)}
    </div>
    <div className="v3-detail-section-head">{(["short","long"] as const).map(value=><Button key={value} size="sm" variant="ghost" aria-pressed={conversation===value} onClick={()=>setConversation(value)}>{value==="short"?"짧은 커멘트":"긴 커멘트"}</Button>)}</div>
    {mode==="board"?<CardBoardWorkspace title={scope==="folder"?"현재 폴더 카드":"전체 카드"} cards={visibleCards} completed={completed} renderCard={(card,handle,preview)=>renderCard(card as typeof cards[number],"compact",handle,preview)} completion={{includeCompleted,onChange}}/>
      : <><PostItGrid>{cards.filter(card=>card.status!=="done").map(card=><div key={card.id}>{renderCard(card,"default")}</div>)}</PostItGrid>{includeCompleted?<CompletedCardCollection browser={completed} renderCard={card=>renderCard(card as typeof cards[number],"default")}/>:null}</>}
    {selectedCard?<CardWorkspace cardId={selectedCard.id} sampleDetail={{...reviewDetail,card:{...selectedCard,brief:conversation==="short"?"내부 요약을 접지 않고 표시합니다.":"내부 요약을 접지 않고 표시합니다.\n\n".repeat(30)},sessions:[{sessionId:reviewSession.agentSessionId,cardId:selectedCard.id,displayName:reviewSession.displayName??null,nodeId:reviewCard.nodeId!,agentId:reviewCard.assigneeAgentId!,status:reviewSession.status,createdAt:reviewCard.createdAt,updatedAt:reviewCard.updatedAt,callerSessionId:null}],comments:Array.from({length:conversation==="short"?1:20},(_,index)=>({id:`detail-comment-${index}`,cardId:selectedCard.id,authorKind:"user",authorId:"sample",sessionId:null,kind:"comment",body:`커멘트 ${index+1}: 탭을 바꾸어도 작성 중 문장과 첨부는 유지됩니다.`,createdAt:reviewCard.createdAt})),questions:[{id:"detail-question",text:"내용을 확인했나요?",options:["확인했습니다"],answer:"확인했습니다",askedAt:reviewCard.createdAt,answeredAt:reviewCard.createdAt}]}} folders={reviewFolders} onClose={()=>setSelected(null)} onOpenSession={()=>onOpen('세션')}
      mobileMode={mobileMode} mobileTab="projects" activeSession={undefined} chatInputDisabled historyEnabled={false} sessionStreamActive={false}
      sessionConnectionStatus="disconnected" reconnectSession={()=>{}} onAcknowledgedReview={()=>{}}/>:null}
  </div>;
}
