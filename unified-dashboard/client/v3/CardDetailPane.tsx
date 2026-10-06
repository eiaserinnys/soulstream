import {dialoguesAssignment} from "./dialogues-api";
import {CardExecutionSettings} from "./CardExecutionSettings";
import {useLocalDialogueUpload} from "./use-local-dialogue-upload";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { DashboardIconCap, useAuth, useDashboardStore, useGlassSurface, type CatalogFolder, type SessionSummary } from "@seosoyoung/soul-ui";
import { ArrowLeft, Check, Play, LoaderCircle, RotateCw } from "lucide-react";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import { cardMutationKey } from "@seosoyoung/soul-ui/cards/card-api";
import {cardExecutionState,subscribeCardExecution,type CardExecutionState} from "@seosoyoung/soul-ui/cards/card-execution";
import { CardStatusPicker, type CardStatusHandle } from "./CardStatusPicker";
import { FolderTitleEditor } from "./FolderTitleEditor";
import { CardSessionHistory, type CardSessionSelection } from "./CardSessionHistory";
import { DetailTabs } from "./DetailTabs";
import { CardTimeline } from "./CardTimeline";
import { CardCommentInput } from "./CardCommentInput";
import "./v3-cards.css";
import type { CardColor, CardComment, CardDetail } from "@seosoyoung/soul-ui/cards/card-types";
import { CardCheckItems } from "./CardCheckItems";
import { CardNowPanel } from "./CardNowPanel";
import { CardNotes } from "./CardNotes";
import { summarizeCardItems } from "./card-item-summary";
const EMPTY_PENDING_CONFIRMATIONS:Readonly<Record<number,boolean>>={};
export { cardRequestMarkdown } from "./card-request-markdown";
export function CardDetailPane({cardId,folders,onClose,onOpenSession,initialSessionId,sampleDetail,sampleExecution,onSampleChange}: {cardId:string;folders:readonly CatalogFolder[];onClose():void;onOpenSession(session:SessionSummary,selection?:CardSessionSelection):void;focus?:string|null;initialSessionId?:string|null;sampleDetail?:CardDetail;sampleExecution?:CardExecutionState;onSampleChange?(update:(current:CardDetail)=>CardDetail):void}) {
 const storedCard=useCardStore(s=>s.byId[cardId]);const storedDetail=useCardStore(s=>s.details[cardId]);const error=useCardStore(s=>s.errors[cardId]);
 const pendingConfirmations=useCardStore(s=>s.pendingItemConfirmations[cardId]??EMPTY_PENDING_CONFIRMATIONS);
 const [localSample,setLocalSample]=useState(sampleDetail);
 const sampleUpload=useLocalDialogueUpload();
 useEffect(()=>setLocalSample(sampleDetail),[sampleDetail]);
 const activeSample=onSampleChange?sampleDetail:localSample?.card.id===cardId?localSample:sampleDetail;
 const updateSample=(update:(current:CardDetail)=>CardDetail)=>{
  if(onSampleChange)onSampleChange(update);
  else setLocalSample(current=>current?update(current):current);
 };
 const card=activeSample?.card??storedCard,detail=activeSample??storedDetail;
 const catalog=useDashboardStore(s=>s.catalog);
 const {user}=useAuth();
 const scroll=useRef<HTMLDivElement>(null);
 const dock=useRef<HTMLDivElement>(null);
 const surface=useRef<HTMLElement>(null);
 const webglActive=useGlassSurface(surface,{enabled:true});
 const tabId=useId();
 const [tab,setTab]=useState<"items"|"comments"|"sessions"|"notes">(()=>card?.items?.length?"items":"comments");
 const initializedTabForCard=useRef<string|null>(null);
 const [targetItemId,setTargetItemId]=useState<number|null>(null);
 const [sentNotice,setSentNotice]=useState(false);
 const [noticeVersion,setNoticeVersion]=useState(0);
 const [unreadComments,setUnreadComments]=useState(false);
 const [focusRequest,setFocusRequest]=useState(0);
 const [dockHeight,setDockHeight]=useState(0);
 const [pending,setPending]=useState(false);
 const statusPicker=useRef<CardStatusHandle>(null);
 const observedExecution=useSyncExternalStore(subscribeCardExecution,()=>cardExecutionState(cardId),()=>undefined);
 const execution=sampleExecution??observedExecution;
 const itemSummary=summarizeCardItems(card?.items,pendingConfirmations);
 const hasCheckItems=Boolean(card?.items?.length);
 const allChecked=hasCheckItems&&itemSummary.activeCount===0;
 const targetItem=targetItemId===null?undefined:card?.items?.find(item=>item.id===targetItemId);
 const startable=card?.status==='todo'||card?.status==='queued';
 const actionLabel=allChecked?'완료':execution?.phase==='pending'?'시작 중…':execution?(execution.phase==='delayed'?'다시 확인':'다시 시도'):startable?'시작하기':'완료';
 const sessionIds=useMemo(()=>[...new Set([...(initialSessionId?[initialSessionId]:[]),...(card?.assigneeSessionId ? [card.assigneeSessionId]:[]),...(detail?.sessions.map(session=>session.sessionId)??[])])],[card?.assigneeSessionId,detail?.sessions,initialSessionId]);
 const assignee=catalog?.sessionList?.find(session=>session.agentSessionId===card?.assigneeSessionId) ?? detail?.sessions.find(session=>session.sessionId===card?.assigneeSessionId);
 const nodeId=assignee?.nodeId ?? card?.nodeId;
 const agentId=assignee?.agentId ?? card?.assigneeAgentId;
 const portrait=nodeId&&agentId ? `/api/nodes/${encodeURIComponent(nodeId)}/agents/${encodeURIComponent(agentId)}/portrait`:"";
 useEffect(()=>{if(!sampleDetail)void useCardStore.getState().loadCard(cardId).catch(()=>undefined);},[cardId,sampleDetail]);
 useEffect(()=>{initializedTabForCard.current=null;setTargetItemId(null);setSentNotice(false);setUnreadComments(false);},[cardId]);
 useEffect(()=>{
  if(!card||initializedTabForCard.current===cardId)return;
  initializedTabForCard.current=cardId;
  setTab(card.items?.length?"items":"comments");setTargetItemId(null);setSentNotice(false);setUnreadComments(false);
 },[cardId,card]);
 useEffect(()=>{if(tab==="comments"&&scroll.current)scroll.current.scrollTop=scroll.current.scrollHeight;},[cardId,detail,tab]);
 useEffect(()=>{
  if(!sentNotice)return;
  const timer=window.setTimeout(()=>setSentNotice(false),6000);
  return ()=>window.clearTimeout(timer);
 },[sentNotice,noticeVersion]);
 useLayoutEffect(()=>{
  const element=dock.current;
  if(!element||typeof ResizeObserver==="undefined")return;
  const observer=new ResizeObserver(()=>setDockHeight(element.getBoundingClientRect().height));
  observer.observe(element);setDockHeight(element.getBoundingClientRect().height);
  return ()=>observer.disconnect();
 },[cardId,targetItemId,sentNotice]);
 const answer=async(questionId:string,text:string)=>{
  if(sampleDetail){updateSample(current=>({...current,questions:current.questions.map(q=>q.id===questionId?{...q,answer:text,answeredAt:new Date().toISOString()}:q)}));return;}
  setPending(true);
  try {await useCardStore.getState().mutate(cardId,`/questions/${encodeURIComponent(questionId)}/answer`,{answer:text});}
  catch {} finally {setPending(false);}
 };
 const submit=async(comment:string)=>{
  if(!comment.trim()||pending)return false;
  const itemId=targetItemId;
  if(sampleDetail){
   const saved:CardComment={id:crypto.randomUUID(),cardId,authorKind:"user",authorId:"sample",sessionId:null,kind:"comment",...(itemId===null?{}:{itemId}),body:comment.trim(),createdAt:new Date().toISOString()};
   updateSample(current=>({...current,card:{...current.card,items:itemId===null?current.card.items:current.card.items?.map(item=>item.id===itemId?{...item,state:"doing",confirmed:null,fixOpen:item.fixOpen+1,display:"fix"}:item)},
    comments:[...(current.comments??[]),saved]}));
   setTargetItemId(null);setSentNotice(true);setNoticeVersion(value=>value+1);if(tab!=="comments")setUnreadComments(true);return true;
  }
  setPending(true);
  try {
   await useCardStore.getState().addComment(cardId,comment.trim(),cardMutationKey(),itemId??undefined);
   setTargetItemId(null);setSentNotice(true);setNoticeVersion(value=>value+1);if(tab!=="comments")setUnreadComments(true);
   return true;
  } catch {return false;} finally {setPending(false);}
 };
 const chooseTargetItem=(itemId:number)=>{
  setTargetItemId(itemId);setSentNotice(false);setFocusRequest(request=>request+1);
 };
 const changeTab=(next:"items"|"comments"|"sessions"|"notes")=>{
  setTab(next);
  if(next==="comments")setUnreadComments(false);
 };
 const confirmItem=async(itemId:number,confirmed:boolean)=>{
  if(sampleDetail){
   updateSample(current=>({...current,card:{...current.card,items:current.card.items?.map(item=>item.id===itemId
    ?confirmed?{...item,state:"done",confirmed:{at:new Date().toISOString(),rev:item.rev},display:"confirmed"}
     :{...item,state:"doing",confirmed:null,display:"changed",reopened:"샘플에서 확인을 풀었습니다."}:item)}}));
   return;
  }
  await useCardStore.getState().confirmItem(cardId,itemId,confirmed);
 };
 const complete=async()=>{
  if(!card || pending)return;
  if(sampleDetail){updateSample(current=>({...current,card:{...current.card,status:"done"}}));onClose();return;}
  setPending(true);
  try {await useCardStore.getState().mutate(cardId,"/status",{status:"done",expectedVersion:card.version});onClose();}
  catch {} finally {setPending(false);}
 };
 if(!card)return <div className="v3-detail-section" role={error?"alert":undefined}>{error??"카드를 불러오는 중…"}</div>;
 const dockStyle={"--v3-card-dock-height":`${dockHeight}px`} as CSSProperties;
 const tabs=[
  ["items",<span className="v3-card-tab-label">확인 항목{itemSummary.toReviewCount>0?<span className="v3-card-tab-count">{itemSummary.toReviewCount}</span>:null}</span>],
  ["comments",<span className="v3-card-tab-label">커멘트{unreadComments?<span className="v3-card-tab-dot" aria-label="새 커멘트"/>:null}</span>],
  ["sessions",<span className="v3-card-tab-label">세션{detail?.sessions.length?<span className="v3-card-tab-total">{detail.sessions.length}</span>:null}</span>],
  ["notes",<span className="v3-card-tab-label">노트{detail?.notes?.length?<span className="v3-card-tab-total">{detail.notes.length}</span>:null}</span>],
 ] as const;
 return <article ref={surface} className="v3-detail-pane v3-card-detail border border-glass-border glass-strong glass-chrome lg-rim" data-liquid-glass-webgl={webglActive?"true":undefined} data-testid="card-detail">
  <header className="v3-folder-header v3-workspace-toolbar v3-detail-gutter">
   <DashboardIconCap label="카드 닫기" onClick={onClose}><ArrowLeft className="h-4 w-4"/></DashboardIconCap>
   <FolderTitleEditor leading={<CardStatusPicker sampleExecution={sampleExecution} ref={statusPicker} card={card} onOpen={()=>{}} control={{pending,
    assignment:sampleDetail?dialoguesAssignment:undefined,folders,
    saveSettings:sampleDetail?async(value)=>{const saved={...card,folderId:value.folderId,nodeId:value.nodeId,assigneeAgentId:value.agentId,modelPreset:value.modelPreset,version:card.version+1};updateSample(current=>({...current,card:saved}));return saved;}:undefined,
    load:()=>sampleDetail ? Promise.resolve(activeSample!) : useCardStore.getState().loadCard(cardId),
    change:async(latest,status,reason)=>{if(sampleDetail)updateSample(current=>({...current,card:{...current.card,...latest,status,...(status==="running"?{assigneeKind:"session",assigneeSessionId:current.sessions[0]?.sessionId??"sample-session"}: {})}}));else if(status==="running")await useCardStore.getState().execute(cardId,latest.version);else await useCardStore.getState().mutate(cardId,"/status",{status,expectedVersion:latest.version,...(reason?{reason}:{})});},
    changeColor:async(latest,color:CardColor)=>{if(sampleDetail)updateSample(current=>({...current,card:{...current.card,color,version:latest.version+1}}));else await useCardStore.getState().mutate(cardId,"",{color,expectedVersion:latest.version},"PATCH");},
   }}/>} variant="card" title={card.title} headingLevel={1} onRename={async title=>{if(sampleDetail)updateSample(current=>({...current,card:{...current.card,title}}));else await useCardStore.getState().mutate(cardId,"",{title,expectedVersion:card.version},"PATCH");}}/>
   <div className="v3-folder-header-actions" data-complete-emphasis={allChecked||undefined}><DashboardIconCap label={actionLabel} disabled={pending||execution?.phase==='pending'} onClick={()=>{if(!allChecked&&(execution||startable))statusPicker.current?.request('running');else void complete();}}>{execution?.phase==='pending'?<LoaderCircle className="h-4 w-4 animate-spin"/>:allChecked?<Check className="h-4 w-4"/>:execution?<RotateCw className="h-4 w-4"/>:startable?<Play className="h-4 w-4"/>:<Check className="h-4 w-4"/>}</DashboardIconCap></div>
  </header>
  {!card.assigneeSessionId?<div className="v3-detail-gutter v3-task-detail-content v3-card-context">
   <section className="v3-detail-section"><CardExecutionSettings assignment={sampleDetail?dialoguesAssignment:undefined} card={card} folders={folders} onSave={sampleDetail?async(value)=>{const saved={...card,folderId:value.folderId,nodeId:value.nodeId,assigneeAgentId:value.agentId,modelPreset:value.modelPreset,version:card.version+1};updateSample(current=>({...current,card:saved}));return saved;}:undefined}/></section>
  </div>:null}
  {card.now?<div key={cardId} className="v3-detail-gutter v3-card-now-slot"><CardNowPanel now={card.now} nowHistory={detail?.nowHistory} itemsCount={card.items?.length??0} activeCount={itemSummary.activeCount} onComplete={()=>void complete()} pending={pending||execution?.phase==='pending'}/></div>:null}
  <div className="v3-detail-gutter v3-card-tabs"><DetailTabs id={tabId} label="카드 보기" panelId={`${tabId}-panel`} variant="card" tabs={tabs} value={tab} onChange={changeTab}/></div>
  {execution && execution.phase!=="pending"?<p role={execution.phase==="error"?"alert":"status"} className="v3-card-error">{execution.message}</p>:null}
  {error?<p role="alert" className="v3-card-error">{error}</p>:null}
  <div className="v3-detail-scroll v3-card-panel-scroll v3-detail-gutter" data-card-active-tab={tab} ref={scroll} style={dockStyle} role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-${tab}`}>
   <div className="v3-task-detail-content">
    <section className="v3-detail-section" data-card-tab-panel="items" hidden={tab!=="items"}>
     <CardCheckItems key={cardId} items={card.items} pendingConfirmations={pendingConfirmations} onConfirmChange={confirmItem} onTargetItem={chooseTargetItem}/>
    </section>
    <section className="v3-detail-section" data-card-tab-panel="comments" hidden={tab!=="comments"}>
     <CardTimeline key={cardId} card={card} detail={detail} portraitUrl={portrait} userPortraitUrl={user?.picture??""} pending={pending} onAnswer={(id,text)=>void answer(id,text)}/>
    </section>
    <section className="v3-detail-section v3-card-session-history" data-card-section="sessions" data-card-tab-panel="sessions" hidden={tab!=="sessions"}>
     <CardSessionHistory key={`${cardId}:${initialSessionId??""}`} sessionIds={sessionIds} linkedSessions={detail?.sessions} assigneeSessionId={card.assigneeKind==="session"?card.assigneeSessionId:null} initialSessionId={initialSessionId} onOpenSession={onOpenSession}/>
    </section>
    <section className="v3-detail-section v3-description-content" data-card-tab-panel="notes" hidden={tab!=="notes"}>
     <CardNotes key={cardId} brief={card.brief??""} notes={detail?.notes??[]} sessions={detail?.sessions??[]} portraitUrl={portrait} userPortraitUrl={user?.picture??""}/>
    </section>
   </div>
  </div>
  <div className="v3-card-composer-slot" ref={dock}>
   {targetItemId!==null?<div className="v3-card-target-notice" role="status"><span>대상: {targetItemId}번 {targetItem?.title??"항목"}</span><button type="button" aria-label="커멘트 대상 해제" onClick={()=>setTargetItemId(null)}>해제</button></div>:null}
   {sentNotice?<div className="v3-card-sent-notice" role="status">보냈습니다. <button type="button" onClick={()=>changeTab("comments")}>커멘트에서 보기</button></div>:null}
   <CardCommentInput uploadController={sampleDetail?sampleUpload:undefined} key={cardId} cardId={cardId} nodeId={nodeId} sessionId={card.assigneeSessionId} pending={pending} focusRequest={focusRequest} onSend={submit}/>
  </div>
 </article>;
}
