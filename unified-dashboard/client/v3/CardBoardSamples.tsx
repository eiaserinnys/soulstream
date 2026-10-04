import {dialoguesAssignment} from "./dialogues-api";
import {createPortal} from "react-dom";
import { useCallback,useMemo,useState, type ReactNode } from "react";
import { Button, DashboardIconCap, useDashboardStore, type SessionSummary } from "@seosoyoung/soul-ui";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { CardCreateDialog } from "./CardCreateDialog";
import type { CardStatus } from "@seosoyoung/soul-ui/cards/card-types";
import { boardColumns } from "./CardBoard";
import { CardBoardWorkspace } from "./CardBoardWorkspace";
import { CardCompletionFilter } from "./CardCompletionFilter";
import { PostItCardView, PostItGrid, type PostItVariant } from "./PostItCard";
import { reviewCard, reviewDetail, reviewFolders, reviewSession, reviewTitle } from "./components-review-fixtures";
import { CardWorkspace } from "./CardWorkspace";
import { MobilePlannerTabs, useMobilePlannerMode } from "./MobilePlannerTabs";
import type {MobilePlannerTab} from "./mobile-planner-state";
import { useCompletedCards,type CompletedPageLoader } from "./use-completed-cards";
import { CompletedCardCollection } from "./CompletedCardCollection";
import { activateRunSession } from "./folder-workspace-run-model";

/** The actual board and card, with fixture-only state and no operational writes. */
export function CardBoardSamples() {
  const queryClient=useQueryClient();
  const [scope,setScope]=useState<"folder"|"all">("folder");
  const [mode,setMode]=useState<"board"|"grid">("board");
  const [scenario,setScenario]=useState<"mixed"|"none"|"done">("mixed");
  const [assignmentScenario,setAssignmentScenario]=useState<'unassigned'|'partial'|'agent'|'assigned'|'live'>('assigned');
  const assignmentSession={...reviewSession,status:assignmentScenario==='live'?'running' as const:'completed' as const};
  const [settings,setSettings]=useState<Record<string,Partial<typeof reviewCard>>>({});
  const assignmentCard=assignmentScenario==='assigned'||assignmentScenario==='live'
    ?{assigneeKind:'session' as const,assigneeSessionId:reviewSession.agentSessionId,nodeId:'sample-node',assigneeAgentId:null,modelPreset:'sample-sol'}
    :{assigneeKind:assignmentScenario==='agent'?'agent' as const:null,assigneeSessionId:null,nodeId:assignmentScenario==='partial'?'sample-node':null,assigneeAgentId:assignmentScenario==='agent'?'roselin':null,modelPreset:null};
  const [includeCompleted,onChange]=useState(false);
  const [statuses,setStatuses]=useState<Record<string,CardStatus>>({});
  const [conversation,setConversation]=useState<"short"|"long">("short");
  const [selected,setSelected]=useState<string|null>(null);
  const [selectedSession,setSelectedSession]=useState<SessionSummary>();
  const [mobileTab,setMobileTab]=useState<MobilePlannerTab>("projects");
  const [adding,setAdding]=useState(false);
  const mobileMode=useMobilePlannerMode();
  const cards=useMemo(()=>boardColumns.flatMap(({status},index)=>Array.from({length:index===0?4:status==='done'?1000:1},(_,copy)=>({
    ...reviewCard,...assignmentCard,...settings[`board-${index}-${copy}`],id:`board-${index}-${copy}`,status:statuses[`board-${index}-${copy}`]??(assignmentScenario==='live'?'running':scenario==="done"?"done":status),
    title:index===0?reviewTitle:`${boardColumns[index].label} 카드`,blockedKind:status==="blocked"?"question" as const:null,
    completedAt:new Date(Date.now()-copy*10*60*1000).toISOString(),
    latestActivity:{kind:index===0?"instruction" as const:"report" as const,format:"markdown" as const,
      body:"긴 본문이 있어도 카드와 열의 폭을 줄이지 않습니다. 최신 원문은 네 줄까지 읽고 상세에서 이어 봅니다. ".repeat(5),createdAt:reviewCard.createdAt},
  }))).filter(card=>scenario!=="none"||card.status!=="done"),[scenario,statuses,assignmentScenario,settings]);
  const loader=useCallback<CompletedPageLoader>(async params=>{
    const result=cards.filter(card=>card.status==='done'&&(!params.completedFrom||card.completedAt>=params.completedFrom)&&(!params.completedBefore||card.completedAt<params.completedBefore)&&(`${card.title} ${card.request}`.toLocaleLowerCase().includes((params.q??'').toLocaleLowerCase()))).sort((a,b)=>b.completedAt.localeCompare(a.completedAt)||b.id.localeCompare(a.id));
    const offset=Number(params.cursor??0),limit=params.limit??60;
    return {cards:result.slice(offset,offset+limit),nextCursor:offset+limit<result.length?String(offset+limit):null};
  },[cards]);
  const completed=useCompletedCards(undefined,includeCompleted,loader);
  const visibleCards=[...cards.filter(card=>card.status!=='done'),...completed.cards];
  const doneCount=cards.filter(card=>card.status==="done").length;
  const renderCard=(card:typeof cards[number],variant:PostItVariant="compact",handle?:ReactNode,preview=false)=><PostItCardView card={card} variant={variant} activity={card.latestActivity} handle={handle} assignee={reviewSession}
    onOpen={()=>{
      // Seed the existing ID query with review fixtures; keep the operational resolver.
      queryClient.setQueryData(["sessions","ids",null,[reviewSession.agentSessionId]],{
        pages:[{sessions:[assignmentSession],total:1}],pageParams:[0],
      });
      setSelectedSession(undefined);setMobileTab("projects");setSelected(card.id);
    }}
    completion={preview?undefined:{pending:false,onComplete:()=>setStatuses(previous=>({...previous,[card.id]:"done"}))}}
    statusControl={preview?undefined:{pending:false,folders:reviewFolders,assignment:dialoguesAssignment,
      saveSettings:async(value)=>{const saved={...card,folderId:value.folderId,nodeId:value.nodeId,assigneeAgentId:value.agentId,modelPreset:value.modelPreset,version:card.version+1};setSettings(previous=>({...previous,[card.id]:saved}));return saved;},load:async()=>({card,reports:card.status==="todo"?[]:[{id:"sample-report",title:"보고",body:"보고",format:"markdown",createdAt:card.createdAt,sessionId:null}],
      questions:card.status==="blocked"?[{id:"sample-question",text:"질문",answer:null,options:null,askedAt:card.createdAt,answeredAt:null}]:[],sessions:[]}),
      change:async(latest,status)=>{setStatuses(previous=>({...previous,[card.id]:status}));if(status==='running')setSettings(previous=>({...previous,[card.id]:{...latest,assigneeKind:'session',assigneeSessionId:reviewSession.agentSessionId}}));}}}/>;
  const comparison={...cards[0],id:"board-size-comparison",status:statuses["board-size-comparison"]??(assignmentScenario==='live'?'running':"review") as CardStatus};
  const selectedCard=selected===comparison.id?comparison:cards.find(card=>card.id===selected);
  const mobileTabsHost=selectedCard&&mobileMode?document.querySelector('.v3-shell.v3-components-page'):null;
  return <div className="v3-card-board-sample" data-testid="card-board-sample">
    {adding?<CardCreateDialog assignment={dialoguesAssignment} onSave={async()=>({id:"sample-created"})} folders={reviewFolders} initialFolderId={scope==="folder"?reviewFolders[0].id:undefined} onClose={()=>setAdding(false)}/>:null}
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
    <div className="v3-detail-section-head">{(['unassigned','partial','agent','assigned','live'] as const).map(value=><Button key={value} size="sm" variant="ghost" aria-pressed={assignmentScenario===value} onClick={()=>{setSelected(null);setSettings({});setAssignmentScenario(value);}}>{{unassigned:'담당 없음',partial:'부분 설정',agent:'에이전트 지정',assigned:'담당 연결',live:'실행 중'}[value]}</Button>)}</div>
    <div className="v3-detail-section-head">{(["short","long"] as const).map(value=><Button key={value} size="sm" variant="ghost" aria-pressed={conversation===value} onClick={()=>setConversation(value)}>{value==="short"?"짧은 커멘트":"긴 커멘트"}</Button>)}</div>
    {mode==="board"?<CardBoardWorkspace title={scope==="folder"?"현재 폴더 카드":"전체 카드"} cards={visibleCards} completed={completed} renderCard={(card,handle,preview)=>renderCard(card as typeof cards[number],"compact",handle,preview)} completion={{includeCompleted,onChange}}
      draftAction={<DashboardIconCap size="small" label="새 카드" onClick={()=>setAdding(true)}><Plus className="h-4 w-4"/></DashboardIconCap>}/>
      : <><PostItGrid>{cards.filter(card=>card.status!=="done").map(card=><div key={card.id}>{renderCard(card,"default")}</div>)}</PostItGrid>{includeCompleted?<CompletedCardCollection browser={completed} renderCard={card=>renderCard(card as typeof cards[number],"default")}/>:null}</>}
    {selectedCard?<CardWorkspace cardId={selectedCard.id} sampleDetail={{...reviewDetail,card:{...selectedCard,brief:conversation==="short"?"내부 요약을 접지 않고 표시합니다.":"내부 요약을 접지 않고 표시합니다.\n\n".repeat(30)},sessions:[{sessionId:reviewSession.agentSessionId,cardId:selectedCard.id,displayName:reviewSession.displayName??null,nodeId:reviewCard.nodeId!,agentId:reviewCard.assigneeAgentId!,status:assignmentSession.status,createdAt:reviewCard.createdAt,updatedAt:reviewCard.updatedAt,callerSessionId:null}],comments:Array.from({length:conversation==="short"?1:20},(_,index)=>({id:`detail-comment-${index}`,cardId:selectedCard.id,authorKind:"user",authorId:"sample",sessionId:null,kind:"comment",body:`커멘트 ${index+1}: 탭을 바꾸어도 작성 중 문장과 첨부는 유지됩니다.`,createdAt:reviewCard.createdAt})),questions:[{id:"detail-question",text:"내용을 확인했나요?",options:["확인했습니다"],answer:"확인했습니다",askedAt:reviewCard.createdAt,answeredAt:reviewCard.createdAt}]}} folders={reviewFolders} onClose={()=>setSelected(null)} onOpenSession={session=>{
        activateRunSession(session,useDashboardStore.getState());setSelectedSession(session);setMobileTab("chat");
      }}
      mobileMode={mobileMode} mobileTab={mobileTab} activeSession={selectedSession} chatInputDisabled historyEnabled={false} sessionStreamActive={false}
      sessionConnectionStatus="disconnected" reconnectSession={()=>{}} onAcknowledgedReview={()=>{}}/>:null}
    {mobileTabsHost?createPortal(<MobilePlannerTabs activeTab={mobileTab} onSelect={setMobileTab}/>,mobileTabsHost):null}
  </div>;
}
