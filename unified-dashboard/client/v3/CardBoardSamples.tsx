import {dialoguesAssignment} from "./dialogues-api";
import {createPortal} from "react-dom";
import { useCallback,useMemo,useState } from "react";
import { Button, DashboardIconCap, useDashboardStore, type SessionSummary } from "@seosoyoung/soul-ui";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { CardCreateDialog } from "./CardCreateDialog";
import type { CardDetail, CardRow, CardStatus } from "@seosoyoung/soul-ui/cards/card-types";
import { boardColumns } from "./CardBoard";
import { CardBoardWorkspace } from "./CardBoardWorkspace";
import { CardCompletionFilter } from "./CardCompletionFilter";
import { PostItCardView, PostItGrid, type PostItVariant } from "./PostItCard";
import { reviewCard, reviewCardItems, reviewDetail, reviewFolders, reviewNow, reviewNowHistory, reviewNotes, reviewSession, reviewTitle } from "./components-review-fixtures";
import { CardWorkspace } from "./CardWorkspace";
import { MobilePlannerTabs, useMobilePlannerMode } from "./MobilePlannerTabs";
import type {MobilePlannerTab} from "./mobile-planner-state";
import { useCompletedCards,type CompletedPageLoader } from "./use-completed-cards";
import { CompletedCardCollection } from "./CompletedCardCollection";
import { activateRunSession } from "./folder-workspace-run-model";

const legacyReviewDetail={...reviewDetail};
delete legacyReviewDetail.notes;
delete legacyReviewDetail.nowHistory;

/** The actual board and card, with fixture-only state and no operational writes. */
export function CardBoardSamples() {
  const queryClient=useQueryClient();
  const [scope,setScope]=useState<"folder"|"all">("folder");
  const [mode,setMode]=useState<"board"|"grid">("board");
  const [scenario,setScenario]=useState<"mixed"|"none"|"done"|"empty">("mixed");
  const [assignmentScenario,setAssignmentScenario]=useState<'unassigned'|'partial'|'agent'|'assigned'|'live'>('assigned');
  const assignmentSession={...reviewSession,status:assignmentScenario==='live'?'running' as const:'completed' as const};
  const [settings,setSettings]=useState<Record<string,Partial<typeof reviewCard>>>({});
  const [checkScenario,setCheckScenario]=useState<"full"|"agent"|"outside"|"no-now-complete"|"two-confirmed"|"question-only"|"many-sessions"|"long-caption"|"no-evidence">("full");
  const sampleItems=checkScenario==="question-only"?reviewCardItems.map(item=>({...item,display:"todo" as const,confirmed:null})):checkScenario==="no-now-complete"?reviewCardItems.map(item=>item.display==="dropped"?item:{...item,state:"done" as const,display:"confirmed" as const,confirmed:{at:reviewNow.updatedAt,rev:item.rev}})
    :checkScenario==="long-caption"?reviewCardItems.map(item=>({...item,evidence:item.evidence.map(evidence=>evidence.type==="image"?{...evidence,label:"확대한 이미지 아래에서 긴 설명의 두 번째 줄까지 잘리지 않고 온전히 읽는지 확인합니다".slice(0,40)}:evidence)}))
    :checkScenario==="no-evidence"?reviewCardItems.map(item=>({...item,evidence:[]}))
    :checkScenario==="two-confirmed"?reviewCardItems.filter(item=>item.display!=="confirmed"||item.id!==reviewCardItems.filter(value=>value.display==="confirmed").at(-1)!.id):reviewCardItems;
  const sampleNow=checkScenario==="no-now-complete"?null:checkScenario==="agent"||checkScenario==="outside"?{...reviewNow,turn:checkScenario,ask:checkScenario==="agent"?"결과를 준비하고 있습니다.":"외부 응답을 기다립니다."}:checkScenario==="question-only"?{...reviewNow,turn:"user" as const,ask:"질문에 답해 주세요"}:reviewNow;
  const [sampleDetails,setSampleDetails]=useState<Record<string,CardDetail>>({});
  const assignmentCard=assignmentScenario==='assigned'||assignmentScenario==='live'
    ?{assigneeKind:'session' as const,assigneeSessionId:reviewSession.agentSessionId,nodeId:'sample-node',assigneeAgentId:null,modelPreset:'sample-sol'}
    :{assigneeKind:assignmentScenario==='agent'?'agent' as const:null,assigneeSessionId:null,nodeId:assignmentScenario==='partial'?'sample-node':null,assigneeAgentId:assignmentScenario==='agent'?'roselin':null,modelPreset:null};
  const [includeCompleted,onChange]=useState(false);
  const [statuses,setStatuses]=useState<Record<string,CardStatus>>({});
  const [startExample,setStartExample]=useState<'normal'|'todo'|'queued'|'pending'>('normal');
  const [conversation,setConversation]=useState<"short"|"long">("short");
  const [selected,setSelected]=useState<string|null>(null);
  const [selectedSession,setSelectedSession]=useState<SessionSummary>();
  const [mobileTab,setMobileTab]=useState<MobilePlannerTab>("projects");
  const [adding,setAdding]=useState(false);
  const mobileMode=useMobilePlannerMode();
  const cards=useMemo(()=>{
    if(scenario==="empty")return [];
    const seeds=boardColumns.flatMap(({status},index)=>Array.from({length:index===0?4:status==='done'?1000:1},(_,copy)=>({
      ...reviewCard,...assignmentCard,...settings[`board-${index}-${copy}`],id:`board-${index}-${copy}`,status:assignmentScenario==='live'?'running':scenario==="done"?"done":status,
      title:index===0?reviewTitle:`${boardColumns[index].label} 카드`,blockedKind:status==="blocked"?"question" as const:null,
      completedAt:new Date(Date.now()-copy*10*60*1000).toISOString(),
      latestActivity:{kind:index===0?"instruction" as const:"report" as const,format:"markdown" as const,
        body:"긴 본문이 있어도 카드와 열의 폭을 줄이지 않습니다. 최신 원문은 네 줄까지 읽고 상세에서 이어 봅니다. ".repeat(5),createdAt:reviewCard.createdAt},
      ...(index===0&&copy===0?{items:sampleItems,now:sampleNow}:{}),
    }))).map(seed=>({...seed,...sampleDetails[seed.id]?.card,completedAt:seed.completedAt}));
    return seeds.filter(card=>(scenario!=="none"||card.status!=="done")
      &&(scenario!=="mixed"||card.status==="todo"||card.status==="running"||card.status==="review"||card.status==="done"))
      .map(card=>({...card,status:statuses[card.id]??card.status}));
  },[scenario,statuses,assignmentScenario,settings,sampleDetails,checkScenario]);
  const loader=useCallback<CompletedPageLoader>(async params=>{
    const result=cards.filter(card=>card.status==='done'&&(!params.completedFrom||card.completedAt>=params.completedFrom)&&(!params.completedBefore||card.completedAt<params.completedBefore)&&(`${card.title} ${card.request}`.toLocaleLowerCase().includes((params.q??'').toLocaleLowerCase()))).sort((a,b)=>b.completedAt.localeCompare(a.completedAt)||b.id.localeCompare(a.id));
    const offset=Number(params.cursor??0),limit=params.limit??60;
    return {cards:result.slice(offset,offset+limit),nextCursor:offset+limit<result.length?String(offset+limit):null};
  },[cards]);
  const completed=useCompletedCards(undefined,includeCompleted,loader);
  const visibleCards=[...cards.filter(card=>card.status!=='done'),...completed.cards];
  const doneCount=cards.filter(card=>card.status==="done").length;
  const renderCard=(card:CardRow,variant:PostItVariant="compact")=><PostItCardView card={card} variant={variant} activity={card.latestActivity??null} assignee={reviewSession}
    onOpen={()=>{
      // Seed the existing ID query with review fixtures; keep the operational resolver.
      queryClient.setQueryData(["sessions","ids",null,[reviewSession.agentSessionId],"card-history"],{
        pages:[{sessions:[assignmentSession],total:1}],pageParams:[0],
      });
      setSelectedSession(undefined);setMobileTab("projects");setSelected(card.id);
    }}
    statusControl={{pending:false,folders:reviewFolders,assignment:dialoguesAssignment,
      saveSettings:async(value)=>{const saved={...card,folderId:value.folderId,nodeId:value.nodeId,assigneeAgentId:value.agentId,modelPreset:value.modelPreset,version:card.version+1};setSettings(previous=>({...previous,[card.id]:saved}));return saved;},load:async()=>({card,reports:card.status==="todo"?[]:[{id:"sample-report",title:"보고",body:"보고",format:"markdown",createdAt:card.createdAt,sessionId:null}],
      questions:card.status==="blocked"?[{id:"sample-question",text:"질문",answer:null,options:null,askedAt:card.createdAt,answeredAt:null}]:[],sessions:[]}),
      change:async(latest,status)=>{setStatuses(previous=>({...previous,[card.id]:status}));if(status==='running')setSettings(previous=>({...previous,[card.id]:{...latest,assigneeKind:'session',assigneeSessionId:reviewSession.agentSessionId}}));}}}/>;
  const comparison={...(cards[0]??reviewCard),...sampleDetails["board-size-comparison"]?.card,id:"board-size-comparison",status:statuses["board-size-comparison"]??sampleDetails["board-size-comparison"]?.card.status??(assignmentScenario==='live'?'running':"review") as CardStatus};
  const selectedCard=selected===comparison.id?comparison:cards.find(card=>card.id===selected);
  const selectedCardDetail=selectedCard?sampleDetails[selectedCard.id]??{
    ...(selectedCard.items?{...reviewDetail,notes:reviewNotes,nowHistory:reviewNowHistory}:legacyReviewDetail),
    card:{...selectedCard,...(startExample==='todo'||startExample==='queued'?{status:startExample}:startExample==='pending'?{status:'running' as const}:{}),brief:conversation==="short"?"내부 요약을 접지 않고 표시합니다.":"내부 요약을 접지 않고 표시합니다.\n\n".repeat(30)},
    sessions:checkScenario==="many-sessions"?Array.from({length:75},(_,i)=>({sessionId:i===0?reviewSession.agentSessionId:`trim-session-${String(i).padStart(3,"0")}`,cardId:selectedCard.id,displayName:`검수 세션 ${i+1}`,nodeId:reviewCard.nodeId!,agentId:reviewCard.assigneeAgentId!,status:"completed",createdAt:new Date(Date.parse(reviewCard.createdAt)+i*60000).toISOString(),updatedAt:reviewCard.updatedAt,callerSessionId:null})):
     [{sessionId:reviewSession.agentSessionId,cardId:selectedCard.id,displayName:reviewSession.displayName??null,nodeId:reviewCard.nodeId!,agentId:reviewCard.assigneeAgentId!,status:assignmentSession.status,createdAt:reviewCard.createdAt,updatedAt:reviewCard.updatedAt,callerSessionId:null}],
    comments:Array.from({length:conversation==="short"?1:20},(_,index)=>({id:`detail-comment-${index}`,cardId:selectedCard.id,authorKind:"user" as const,authorId:"sample",sessionId:null,kind:"comment" as const,body:`커멘트 ${index+1}: 탭을 바꾸어도 작성 중 문장과 첨부는 유지됩니다.`,createdAt:reviewCard.createdAt,...(selectedCard.items&&index===0?{itemId:5}:{})})),
    questions:[{id:"detail-question",text:"내용을 확인했나요?",options:["확인했습니다"],answer:"확인했습니다",askedAt:reviewCard.createdAt,answeredAt:reviewCard.createdAt}],
  }:undefined;
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
      {(["mixed","none","done","empty"] as const).map(value=><Button key={value} size="sm" variant="ghost" aria-pressed={scenario===value} onClick={()=>{setScenario(value);setStatuses({});setSampleDetails({});}}>{{mixed:"혼합",none:"완료 0개",done:"전부 완료",empty:"빈 보드"}[value]}</Button>)}
    </div>
    <div className="v3-detail-section-head">{(['unassigned','partial','agent','assigned','live'] as const).map(value=><Button key={value} size="sm" variant="ghost" aria-pressed={assignmentScenario===value} onClick={()=>{setSelected(null);setSettings({});setSampleDetails({});setAssignmentScenario(value);}}>{{unassigned:'담당 없음',partial:'부분 설정',agent:'에이전트 지정',assigned:'담당 연결',live:'실행 중'}[value]}</Button>)}</div>
    <div className="v3-detail-section-head">{(['normal','todo','queued','pending'] as const).map(value=><Button key={value} size="sm" variant="ghost" aria-pressed={startExample===value} onClick={()=>{setStartExample(value);setSelected(comparison.id);}}>{{normal:'기본 상세',todo:'드래프트 상세',queued:'대기 상세',pending:'시작 확인 중'}[value]}</Button>)}</div>
    <div className="v3-detail-section-head" data-testid="card-check-scenarios">{(["full","agent","outside","no-now-complete","two-confirmed","question-only","many-sessions","long-caption","no-evidence"] as const).map(value=><Button key={value} size="sm" variant="ghost" aria-pressed={checkScenario===value} onClick={()=>{setSelected(null);setSampleDetails({});setCheckScenario(value);}}>{{full:"일곱 상태",agent:"에이전트 차례 띠",outside:"바깥 대기 띠","no-now-complete":"상황판 없이 모두 확인","two-confirmed":"확인함 두 개","question-only":"질문만 있는 카드","many-sessions":"많은 세션","long-caption":"긴 이미지 설명","no-evidence":"캡처 없는 보고"}[value]}</Button>)}</div>
    <div className="v3-detail-section-head">{(["short","long"] as const).map(value=><Button key={value} size="sm" variant="ghost" aria-pressed={conversation===value} onClick={()=>setConversation(value)}>{value==="short"?"짧은 커멘트":"긴 커멘트"}</Button>)}</div>
    {mode==="board"?<CardBoardWorkspace title={scope==="folder"?"현재 폴더 카드":"전체 카드"} cards={visibleCards} completed={completed} renderCard={card=>renderCard(card,"compact")} completion={{includeCompleted,onChange}}
      draftAction={<DashboardIconCap size="small" label="새 카드" onClick={()=>setAdding(true)}><Plus className="h-4 w-4"/></DashboardIconCap>}/>
      : <><PostItGrid>{cards.filter(card=>card.status!=="done").map(card=><div key={card.id}>{renderCard(card,"default")}</div>)}</PostItGrid>{includeCompleted?<CompletedCardCollection browser={completed} renderCard={card=>renderCard(card,"default")}/>:null}</>}
    {selectedCard?<CardWorkspace cardId={selectedCard.id} sampleExecution={startExample==='pending'?{phase:'pending',message:'시작 중…'}:undefined} sampleDetail={selectedCardDetail}
      onSampleChange={update=>setSampleDetails(previous=>({...previous,[selectedCard.id]:update(previous[selectedCard.id]??selectedCardDetail!)}))}
      folders={reviewFolders} onClose={()=>setSelected(null)} onCloseChat={()=>setMobileTab("today")} onOpenSession={(session,selection)=>{
        activateRunSession(session,useDashboardStore.getState());setSelectedSession(session);if(selection?.source!=='automatic')setMobileTab("chat");
      }}
      mobileMode={mobileMode} mobileTab={mobileTab} activeSession={selectedSession} chatInputDisabled historyEnabled={false} sessionStreamActive={false}
      sessionConnectionStatus="disconnected" reconnectSession={()=>{}} onAcknowledgedReview={()=>{}}/>:null}
    {mobileTabsHost?createPortal(<MobilePlannerTabs activeTab={mobileTab} onSelect={setMobileTab}/>,mobileTabsHost):null}
  </div>;
}
