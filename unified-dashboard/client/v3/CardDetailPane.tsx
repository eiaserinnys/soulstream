import {dialoguesAssignment} from "./dialogues-api";
import {CardExecutionSettings} from "./CardExecutionSettings";
import {useLocalDialogueUpload} from "./use-local-dialogue-upload";
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { DashboardIconCap, MarkdownContent, useAuth, useDashboardStore, useGlassSurface, type CatalogFolder, type SessionSummary } from "@seosoyoung/soul-ui";
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
import type { CardDetail } from "@seosoyoung/soul-ui/cards/card-types";
export { cardRequestMarkdown } from "./card-request-markdown";
export function CardDetailPane({cardId,folders,onClose,onOpenSession,initialSessionId,sampleDetail,sampleExecution}: {cardId:string;folders:readonly CatalogFolder[];onClose():void;onOpenSession(session:SessionSummary,selection?:CardSessionSelection):void;focus?:string|null;initialSessionId?:string|null;sampleDetail?:CardDetail;sampleExecution?:CardExecutionState}) {
 const storedCard=useCardStore(s=>s.byId[cardId]);const storedDetail=useCardStore(s=>s.details[cardId]);const error=useCardStore(s=>s.errors[cardId]);
 const [localSample,setLocalSample]=useState(sampleDetail);
 const sampleUpload=useLocalDialogueUpload();
 useEffect(()=>setLocalSample(sampleDetail),[sampleDetail]);
 const card=localSample?.card??storedCard,detail=localSample??storedDetail;
 const catalog=useDashboardStore(s=>s.catalog);
 const {user}=useAuth();
 const scroll=useRef<HTMLDivElement>(null);
 const surface=useRef<HTMLElement>(null);
 const webglActive=useGlassSurface(surface,{enabled:true});
 const tabId=useId();
 const [tab,setTab]=useState<"comments"|"content">("comments");
 const [pending,setPending]=useState(false);
 const statusPicker=useRef<CardStatusHandle>(null);
 const observedExecution=useSyncExternalStore(subscribeCardExecution,()=>cardExecutionState(cardId),()=>undefined);
 const execution=sampleExecution??observedExecution;
 const startable=card?.status==='todo'||card?.status==='queued';
 const actionLabel=execution?.phase==='pending'?'시작 중…':execution?(execution.phase==='delayed'?'다시 확인':'다시 시도'):startable?'시작하기':'완료';
 const sessionIds=useMemo(()=>[...new Set([...(initialSessionId?[initialSessionId]:[]),...(card?.assigneeSessionId ? [card.assigneeSessionId]:[]),...(detail?.sessions.map(session=>session.sessionId)??[])])],[card?.assigneeSessionId,detail?.sessions,initialSessionId]);
 const assignee=catalog?.sessionList?.find(session=>session.agentSessionId===card?.assigneeSessionId) ?? detail?.sessions.find(session=>session.sessionId===card?.assigneeSessionId);
 const nodeId=assignee?.nodeId ?? card?.nodeId;
 const agentId=assignee?.agentId ?? card?.assigneeAgentId;
 const portrait=nodeId&&agentId ? `/api/nodes/${encodeURIComponent(nodeId)}/agents/${encodeURIComponent(agentId)}/portrait`:"";
 const agentName=assignee && "agentName" in assignee ? assignee.agentName ?? agentId : agentId;
 const model=assignee && "modelLabel" in assignee ? assignee.modelLabel ?? card?.modelPreset : card?.modelPreset;
 useEffect(()=>{if(!sampleDetail)void useCardStore.getState().loadCard(cardId).catch(()=>undefined);},[cardId,sampleDetail]);
 useEffect(()=>{setTab("comments");},[cardId]);
 useEffect(()=>{if(tab==="comments"&&scroll.current)scroll.current.scrollTop=scroll.current.scrollHeight;},[cardId,detail,tab]);
 const answer=async(questionId:string,text:string)=>{
  if(sampleDetail){setLocalSample(current=>current?{...current,questions:current.questions.map(q=>q.id===questionId?{...q,answer:text,answeredAt:new Date().toISOString()}:q)}:current);return;}
  setPending(true);
  try {await useCardStore.getState().mutate(cardId,`/questions/${encodeURIComponent(questionId)}/answer`,{answer:text});}
  catch {} finally {setPending(false);}
 };
 const submit=async(comment:string)=>{
  if(!comment.trim()||pending)return false;
  if(sampleDetail){setLocalSample(current=>current?{...current,comments:[...(current.comments??[]),{id:crypto.randomUUID(),cardId,authorKind:"user",authorId:"sample",sessionId:null,kind:"comment",body:comment,createdAt:new Date().toISOString()}]}:current);return true;}
  setPending(true);
  try {
   await useCardStore.getState().addComment(cardId,comment.trim(),cardMutationKey());
   return true;
  } catch {return false;} finally {setPending(false);}
 };
 const complete=async()=>{
  if(!card || pending)return;
  if(sampleDetail){setLocalSample(current=>current?{...current,card:{...current.card,status:"done"}}:current);return;}
  setPending(true);
  try {await useCardStore.getState().mutate(cardId,"/status",{status:"done",expectedVersion:card.version});onClose();}
  catch {} finally {setPending(false);}
 };
 if(!card)return <div className="v3-detail-section" role={error?"alert":undefined}>{error??"카드를 불러오는 중…"}</div>;
 return <article ref={surface} className="v3-detail-pane v3-card-detail border border-glass-border glass-strong glass-chrome lg-rim" data-liquid-glass-webgl={webglActive?"true":undefined} data-testid="card-detail">
  <header className="v3-folder-header v3-workspace-toolbar v3-detail-gutter">
   <DashboardIconCap label="카드 닫기" onClick={onClose}><ArrowLeft className="h-4 w-4"/></DashboardIconCap>
   <CardStatusPicker sampleExecution={sampleExecution} ref={statusPicker} card={card} onOpen={()=>{}} control={{pending,
    assignment:sampleDetail?dialoguesAssignment:undefined,folders,
    saveSettings:sampleDetail?async(value)=>{const saved={...card,folderId:value.folderId,nodeId:value.nodeId,assigneeAgentId:value.agentId,modelPreset:value.modelPreset,version:card.version+1};setLocalSample(current=>current?{...current,card:saved}:current);return saved;}:undefined,
    load:()=>sampleDetail ? Promise.resolve(localSample!) : useCardStore.getState().loadCard(cardId),
    change:async(latest,status,reason)=>{if(sampleDetail)setLocalSample(current=>current?{...current,card:{...current.card,...latest,status,...(status==="running"?{assigneeKind:"session",assigneeSessionId:current.sessions[0]?.sessionId??"sample-session"}: {})}}:current);else if(status==="running")await useCardStore.getState().execute(cardId,latest.version);else await useCardStore.getState().mutate(cardId,"/status",{status,expectedVersion:latest.version,...(reason?{reason}:{})});},
   }}/>
   <FolderTitleEditor title={card.title} headingLevel={1} onRename={async title=>{if(sampleDetail)setLocalSample(current=>current?{...current,card:{...current.card,title}}:current);else await useCardStore.getState().mutate(cardId,"",{title,expectedVersion:card.version},"PATCH");}}/>
   <div className="v3-folder-header-actions"><DashboardIconCap label={actionLabel} disabled={pending||execution?.phase==='pending'} onClick={()=>{if(execution||startable)statusPicker.current?.request('running');else void complete();}}>{execution?.phase==='pending'?<LoaderCircle className="h-4 w-4 animate-spin"/>:execution?<RotateCw className="h-4 w-4"/>:startable?<Play className="h-4 w-4"/>:<Check className="h-4 w-4"/>}</DashboardIconCap></div>
  </header>
  <div className="v3-detail-gutter v3-task-detail-content v3-card-context">
   {!card.assigneeSessionId?<section className="v3-detail-section"><CardExecutionSettings assignment={sampleDetail?dialoguesAssignment:undefined} card={card} folders={folders} onSave={sampleDetail?async(value)=>{const saved={...card,folderId:value.folderId,nodeId:value.nodeId,assigneeAgentId:value.agentId,modelPreset:value.modelPreset,version:card.version+1};setLocalSample(current=>current?{...current,card:saved}:current);return saved;}:undefined}/></section>:null}
   <section className="v3-detail-section v3-card-session-history" data-card-section="sessions"><CardSessionHistory key={`${cardId}:${initialSessionId??""}`} sessionIds={sessionIds} collapsedLimit={3} assigneeSessionId={card.assigneeKind==="session"?card.assigneeSessionId:null} initialSessionId={initialSessionId} onOpenSession={onOpenSession}/></section>
  </div>
  <div className="v3-detail-gutter v3-card-tabs"><DetailTabs<"comments"|"content"> id={tabId} label="카드 보기" panelId={`${tabId}-panel`} tabs={[["comments","커멘트"],["content","내용"]]} value={tab} onChange={setTab}/></div>
  {execution && execution.phase!=="pending"?<p role={execution.phase==="error"?"alert":"status"} className="v3-card-error">{execution.message}</p>:null}
  {error?<p role="alert" className="v3-card-error">{error}</p>:null}
  <div className="v3-detail-scroll v3-card-panel-scroll v3-detail-gutter" ref={scroll} role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-${tab}`}>
   <div className="v3-task-detail-content">
   {tab==="comments"?<section className="v3-detail-section">
   <CardTimeline key={cardId} card={card} detail={detail} portraitUrl={portrait} userPortraitUrl={user?.picture??""} pending={pending} onAnswer={(id,text)=>void answer(id,text)}/>
   </section>:<section className="v3-detail-section v3-description-content"><MarkdownContent content={card.brief??""} codeBlockLayout="document"/></section>}
   </div>
  </div>
  <div className="v3-card-composer-slot"><CardCommentInput uploadController={sampleDetail?sampleUpload:undefined} key={cardId} cardId={cardId} nodeId={nodeId} sessionId={card.assigneeSessionId} pending={pending} onSend={submit}/></div>
 </article>;
}
