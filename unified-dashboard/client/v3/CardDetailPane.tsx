import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { DashboardIconCap, MarkdownContent, ProfileAvatar, useAuth, useDashboardStore, type CatalogFolder, type SessionSummary } from "@seosoyoung/soul-ui";
import { ArrowLeft, ArrowUp } from "lucide-react";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import { cardMutationKey } from "@seosoyoung/soul-ui/cards/card-api";
import { CardStatusChip } from "./CardActions";
import { FolderTitleEditor } from "./FolderTitleEditor";
import { CardSessionHistory } from "./CardSessionHistory";
import { CardTimeline } from "./CardTimeline";
import "./v3-cards.css";
export { cardRequestMarkdown } from "./card-request-markdown";
export function CardDetailPane({cardId,onClose,onOpenSession}: {cardId:string;folders:readonly CatalogFolder[];onClose():void;onOpenSession(session:SessionSummary):void;focus?:string|null;scrollContainerRef?:RefObject<HTMLDivElement|null>}) {
 const card=useCardStore(s=>s.byId[cardId]);const detail=useCardStore(s=>s.details[cardId]);const error=useCardStore(s=>s.errors[cardId]);
 const catalog=useDashboardStore(s=>s.catalog);
 const {user}=useAuth();
 const scroll=useRef<HTMLDivElement>(null),input=useRef<HTMLTextAreaElement>(null);
 const [comment,setComment]=useState(""),[pending,setPending]=useState(false);
 const sessionIds=useMemo(()=>[...new Set([...(card?.assigneeSessionId ? [card.assigneeSessionId]:[]),...(detail?.sessions.map(session=>session.sessionId)??[])])],[card?.assigneeSessionId,detail?.sessions]);
 const assignee=catalog?.sessionList?.find(session=>session.agentSessionId===card?.assigneeSessionId) ?? detail?.sessions.find(session=>session.sessionId===card?.assigneeSessionId);
 const nodeId=assignee?.nodeId ?? card?.nodeId;
 const agentId=assignee?.agentId ?? card?.assigneeAgentId;
 const portrait=nodeId&&agentId ? `/api/nodes/${encodeURIComponent(nodeId)}/agents/${encodeURIComponent(agentId)}/portrait`:"";
 const agentName=assignee && "agentName" in assignee ? assignee.agentName ?? agentId : agentId;
 const model=assignee && "modelLabel" in assignee ? assignee.modelLabel ?? card?.modelPreset : card?.modelPreset;
 const unanswered=detail?.questions.find(q=>!q.answer);
 useEffect(()=>{setComment("");void useCardStore.getState().loadCard(cardId).catch(()=>undefined);},[cardId]);
 useEffect(()=>{if(scroll.current)scroll.current.scrollTop=scroll.current.scrollHeight;},[cardId,detail]);
 const answer=async(questionId:string,text:string)=>{
  setPending(true);
  try {await useCardStore.getState().mutate(cardId,`/questions/${encodeURIComponent(questionId)}/answer`,{answer:text});setComment("");}
  catch {} finally {setPending(false);}
 };
 const submit=async()=>{
  if(!comment.trim()||pending)return;
  if(unanswered){await answer(unanswered.id,comment.trim());return;}
  setPending(true);
  try {await useCardStore.getState().addComment(cardId,comment.trim(),cardMutationKey());setComment("");if(input.current)input.current.style.height="";}
  catch {} finally {setPending(false);}
 };
 const complete=async()=>{
  if(!card || card.status!=="review" || pending)return;
  setPending(true);
  try {await useCardStore.getState().mutate(cardId,"/status",{status:"done",expectedVersion:card.version});}
  catch {} finally {setPending(false);}
 };
 if(!card)return <div className="v3-detail-section" role={error?"alert":undefined}>{error??"카드를 불러오는 중…"}</div>;
 return <article className="v3-detail-pane v3-detail-pane--inline v3-card-detail" data-testid="card-detail">
  <header className="v3-card-panel-header">
   <div className="v3-card-panel-title"><DashboardIconCap label="카드 닫기" onClick={onClose}><ArrowLeft className="h-4 w-4"/></DashboardIconCap>
    <FolderTitleEditor title={card.title} headingLevel={1} onRename={async title=>{await useCardStore.getState().mutate(cardId,"",{title,expectedVersion:card.version},"PATCH");}}/><CardStatusChip card={card}/></div>
   <div className="v3-card-panel-chips"><span className="v3-card-panel-chip"><ProfileAvatar role="assistant" hasPortrait={Boolean(portrait)} portraitUrl={portrait} fallbackEmoji="🤖"/>{agentName??"담당 미지정"}</span>{nodeId?<span className="v3-card-panel-chip">{nodeId}</span>:null}{model?<span className="v3-card-panel-chip">{model}</span>:null}
    <button type="button" className="v3-card-complete" aria-label="완료" disabled={pending||card.status!=="review"} onClick={()=>void complete()}>완료</button></div>
  </header>
  {error?<p role="alert" className="v3-card-error">{error}</p>:null}
  <div className="v3-card-panel-scroll" ref={scroll}>
   <section className="v3-card-session-history" data-card-section="sessions"><CardSessionHistory key={cardId} sessionIds={sessionIds} collapsedLimit={3} onOpenSession={onOpenSession}/></section>
   <CardTimeline key={cardId} card={card} detail={detail} portraitUrl={portrait} userPortraitUrl={user?.picture??""} pending={pending} onAnswer={(id,text)=>void answer(id,text)}/>
   <details className="v3-card-other"><summary>그 밖에</summary><div className="v3-description-content"><MarkdownContent content={card.brief??""} codeBlockLayout="document"/></div></details>
  </div>
  <form className="v3-card-comment-dock" onSubmit={e=>{e.preventDefault();void submit();}}><div className="v3-card-comment-input">
   <textarea ref={input} rows={1} aria-label="커멘트" placeholder={unanswered ? "질문에 답하기":"커멘트"} value={comment} disabled={pending} onChange={e=>{setComment(e.target.value);e.target.style.height="auto";e.target.style.height=`${e.target.scrollHeight}px`;}} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();e.currentTarget.form?.requestSubmit();}}}/>
   <DashboardIconCap label="커멘트 전송" type="submit" disabled={pending||!comment.trim()}><ArrowUp className="h-4 w-4"/></DashboardIconCap>
  </div></form>
 </article>;
}
