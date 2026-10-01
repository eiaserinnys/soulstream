import { useEffect, useMemo, useRef, useState } from "react";
import { DashboardIconCap, MarkdownContent, useAuth, useDashboardStore, useGlassSurface, type CatalogFolder, type SessionSummary } from "@seosoyoung/soul-ui";
import { ArrowLeft, Check } from "lucide-react";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import { cardMutationKey } from "@seosoyoung/soul-ui/cards/card-api";
import { CardStatusChip } from "./CardActions";
import { FolderTitleEditor } from "./FolderTitleEditor";
import { CardSessionHistory } from "./CardSessionHistory";
import { CardTimeline } from "./CardTimeline";
import { CardCommentInput } from "./CardCommentInput";
import "./v3-cards.css";
export { cardRequestMarkdown } from "./card-request-markdown";
export function CardDetailPane({cardId,onClose,onOpenSession}: {cardId:string;folders:readonly CatalogFolder[];onClose():void;onOpenSession(session:SessionSummary):void;focus?:string|null}) {
 const card=useCardStore(s=>s.byId[cardId]);const detail=useCardStore(s=>s.details[cardId]);const error=useCardStore(s=>s.errors[cardId]);
 const catalog=useDashboardStore(s=>s.catalog);
 const {user}=useAuth();
 const scroll=useRef<HTMLDivElement>(null);
 const surface=useRef<HTMLElement>(null);
 const webglActive=useGlassSurface(surface,{enabled:true});
 const [pending,setPending]=useState(false);
 const sessionIds=useMemo(()=>[...new Set([...(card?.assigneeSessionId ? [card.assigneeSessionId]:[]),...(detail?.sessions.map(session=>session.sessionId)??[])])],[card?.assigneeSessionId,detail?.sessions]);
 const assignee=catalog?.sessionList?.find(session=>session.agentSessionId===card?.assigneeSessionId) ?? detail?.sessions.find(session=>session.sessionId===card?.assigneeSessionId);
 const nodeId=assignee?.nodeId ?? card?.nodeId;
 const agentId=assignee?.agentId ?? card?.assigneeAgentId;
 const portrait=nodeId&&agentId ? `/api/nodes/${encodeURIComponent(nodeId)}/agents/${encodeURIComponent(agentId)}/portrait`:"";
 const agentName=assignee && "agentName" in assignee ? assignee.agentName ?? agentId : agentId;
 const model=assignee && "modelLabel" in assignee ? assignee.modelLabel ?? card?.modelPreset : card?.modelPreset;
 useEffect(()=>{void useCardStore.getState().loadCard(cardId).catch(()=>undefined);},[cardId]);
 useEffect(()=>{if(scroll.current)scroll.current.scrollTop=scroll.current.scrollHeight;},[cardId,detail]);
 const answer=async(questionId:string,text:string)=>{
  setPending(true);
  try {await useCardStore.getState().mutate(cardId,`/questions/${encodeURIComponent(questionId)}/answer`,{answer:text});}
  catch {} finally {setPending(false);}
 };
 const submit=async(comment:string)=>{
  if(!comment.trim()||pending)return false;
  setPending(true);
  try {
   await useCardStore.getState().addComment(cardId,comment.trim(),cardMutationKey());
   return true;
  } catch {return false;} finally {setPending(false);}
 };
 const complete=async()=>{
  if(!card || card.status!=="review" || pending)return;
  setPending(true);
  try {await useCardStore.getState().mutate(cardId,"/status",{status:"done",expectedVersion:card.version});}
  catch {} finally {setPending(false);}
 };
 if(!card)return <div className="v3-detail-section" role={error?"alert":undefined}>{error??"카드를 불러오는 중…"}</div>;
 return <article ref={surface} className="v3-detail-pane v3-card-detail border border-glass-border glass-strong glass-chrome lg-rim" data-liquid-glass-webgl={webglActive?"true":undefined} data-testid="card-detail">
  <header className="v3-folder-header v3-workspace-toolbar v3-detail-gutter">
   <DashboardIconCap label="카드 닫기" onClick={onClose}><ArrowLeft className="h-4 w-4"/></DashboardIconCap>
   <CardStatusChip card={card}/>
   <FolderTitleEditor title={card.title} headingLevel={1} onRename={async title=>{await useCardStore.getState().mutate(cardId,"",{title,expectedVersion:card.version},"PATCH");}}/>
   <div className="v3-folder-header-actions"><DashboardIconCap label="완료" disabled={pending||card.status!=="review"} onClick={()=>void complete()}><Check className="h-4 w-4"/></DashboardIconCap></div>
  </header>
  {error?<p role="alert" className="v3-card-error">{error}</p>:null}
  <div className="v3-detail-scroll v3-card-panel-scroll v3-detail-gutter" ref={scroll}>
   <div className="v3-task-detail-content">
   <section className="v3-detail-section"><div className="v3-task-default-values"><span>{agentName??"담당 미지정"}</span>{nodeId?<span>{nodeId}</span>:null}{model?<span>{model}</span>:null}</div></section>
   <section className="v3-detail-section v3-card-session-history" data-card-section="sessions"><CardSessionHistory key={cardId} sessionIds={sessionIds} collapsedLimit={3} onOpenSession={onOpenSession}/></section>
   <section className="v3-detail-section">
   <CardTimeline key={cardId} card={card} detail={detail} portraitUrl={portrait} userPortraitUrl={user?.picture??""} pending={pending} onAnswer={(id,text)=>void answer(id,text)}/>
   </section>
   <details className="v3-detail-section v3-card-other"><summary>그 밖에</summary><div className="v3-description-content"><MarkdownContent content={card.brief??""} codeBlockLayout="document"/></div></details>
   </div>
  </div>
  <CardCommentInput key={cardId} nodeId={nodeId} sessionId={card.assigneeSessionId} pending={pending} onSend={submit}/>
 </article>;
}
