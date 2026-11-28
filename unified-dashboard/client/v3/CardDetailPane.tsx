import { useTranslation } from "react-i18next";
import type {CardExecutionState} from "@seosoyoung/soul-ui/cards/card-execution-state";
import {dialoguesAssignment} from "./dialogues-api";
import {CardExecutionSettings} from "./CardExecutionSettings";
import {useLocalDialogueUpload} from "./use-local-dialogue-upload";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { Button, DashboardIconCap, FrameLoading, StatusChip, useAuth, useAgentPortraitUrlResolver, useDashboardStore, useGlassSurface, type CatalogFolder, type SessionSummary } from "@seosoyoung/soul-ui";
import { ArrowLeft, Check, Play, LoaderCircle, RotateCw, ChevronRight } from "lucide-react";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import { cardMutationKey, cardQuestionChoiceAnswer, cardQuestionTextAnswer } from "@seosoyoung/soul-ui/cards/card-api";
import {cardExecutionState,subscribeCardExecution} from "@seosoyoung/soul-ui/cards/card-execution";
import { CardStatusPicker, type CardStatusControl, type CardStatusHandle } from "./CardStatusPicker";
import { FolderTitleEditor } from "./FolderTitleEditor";
import { CardSessionHistory, type CardSessionSelection } from "./CardSessionHistory";
import { DetailTabs } from "./DetailTabs";
import { CardTimeline } from "./CardTimeline";
import { CardQuestionNotice, isOpenCardQuestion } from "./CardQuestionBlock";
import { cardDetailTargetScope, cardQuestionTargetGeneration, clearCardQuestionTarget, setCardQuestionTarget, useCardQuestionTarget } from "./card-question-target";
import { CardCommentInput } from "./CardCommentInput";
import "./v3-cards.css";
import type { CardColor } from "../../../packages/wire-schema/src/card_colors";
import type { CardComment, CardDetail } from "@seosoyoung/soul-ui/cards/card-types";
import { CardCheckItems } from "./CardCheckItems";
import { CardNowPanel } from "./CardNowPanel";
import { CardNotes } from "./CardNotes";
import { summarizeCardItems } from "./card-item-summary";
import { useCardNavigation } from "./card-navigation";
import { cardDependencyStatus } from "./CardActions";
import { cardDependencyStopReason } from "../../../packages/wire-schema/src/card_dependency_display";
const EMPTY_PENDING_CONFIRMATIONS:Readonly<Record<number,boolean>>={};
export { cardRequestMarkdown } from "./card-request-markdown";
export type CardDetailPaneProps={cardId:string;folders:readonly CatalogFolder[];onClose():void;onOpenSession(session:SessionSummary,selection?:CardSessionSelection):void;focus?:string|null;initialSessionId?:string|null;sampleDetail?:CardDetail;sampleExecution?:CardExecutionState;onSampleChange?(update:(current:CardDetail)=>CardDetail):void};
export function CardDetailPane(props:CardDetailPaneProps) {
 const {t}=useTranslation();
 const {cardId,folders,onClose,onOpenSession,initialSessionId,sampleDetail,sampleExecution,onSampleChange}=props;
 const openCard=useCardNavigation(s=>s.open);
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
 const detail=activeSample??storedDetail,card=activeSample?.card??storedCard;
 const catalog=useDashboardStore(s=>s.catalog);
 const {user}=useAuth();
 const scroll=useRef<HTMLDivElement>(null);
 const previousTimeline=useRef<{cardId:string;tab:string;questions:number;reports:number;comments:number}|null>(null);
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
 const [focusRequest,setFocusRequest]=useState(()=>({cardId,value:0}));
 const [dockHeight,setDockHeight]=useState(0);
 const [pending,setPending]=useState(false);
 const statusPicker=useRef<CardStatusHandle>(null);
 const questionScope=cardDetailTargetScope(cardId);
 const questionTarget=useCardQuestionTarget(questionScope);
 const validTarget=questionTarget.target&&(!detail||detail.questions.some(question=>question.id===questionTarget.target!.questionId))?questionTarget.target:null;
 const observedExecution=useSyncExternalStore(subscribeCardExecution,()=>cardExecutionState(cardId),()=>undefined);
 const execution=sampleExecution??observedExecution;
 const itemSummary=summarizeCardItems(card?.items,pendingConfirmations);
 const hasCheckItems=Boolean(card?.items?.length);
 const allChecked=hasCheckItems&&itemSummary.activeCount===0;
 const targetItem=targetItemId===null?undefined:card?.items?.find(item=>item.id===targetItemId);
 const startable=card?.status==='todo'||card?.status==='queued'||card?.status==='on_hold';
 const actionLabel=allChecked?t("cards.complete"):execution?.phase==='pending'?t("cards.starting"):execution?(execution.phase==='delayed'?t("cards.checkAgain"):t("cards.retry")):startable?t("cards.start"):t("cards.complete");
 const sessionIds=useMemo(()=>[...new Set([...(initialSessionId?[initialSessionId]:[]),...(card?.assigneeSessionId ? [card.assigneeSessionId]:[]),...(detail?.sessions.map(session=>session.sessionId)??[])])],[card?.assigneeSessionId,detail?.sessions,initialSessionId]);
 const assignee=catalog?.sessionList?.find(session=>session.agentSessionId===card?.assigneeSessionId) ?? detail?.sessions.find(session=>session.sessionId===card?.assigneeSessionId);
 const nodeId=assignee?.nodeId ?? card?.nodeId;
 const agentId=assignee?.agentId ?? card?.assigneeAgentId;
 const resolvePortrait=useAgentPortraitUrlResolver();
 const portrait=resolvePortrait(agentId);
 useEffect(()=>{if(!sampleDetail)void useCardStore.getState().loadCard(cardId,t).catch(()=>undefined);},[cardId,sampleDetail,t]);
 // 되묻기·덧붙이기 대상은 이 카드 상세가 살아 있는 동안만 산다.
 useEffect(()=>()=>clearCardQuestionTarget(questionScope),[questionScope]);
 useEffect(()=>{if(questionTarget.target&&detail&&!detail.questions.some(question=>question.id===questionTarget.target!.questionId))clearCardQuestionTarget(questionScope);},[detail,questionScope,questionTarget.target]);
 useEffect(()=>{initializedTabForCard.current=null;setTargetItemId(null);setSentNotice(false);setUnreadComments(false);setFocusRequest({cardId,value:0});},[cardId]);
 useEffect(()=>{
  if(!card||initializedTabForCard.current===cardId)return;
  initializedTabForCard.current=cardId;
  setTab(card.items?.length?"items":"comments");setTargetItemId(null);setSentNotice(false);setUnreadComments(false);
 },[cardId,card]);
 const cardAvailable=Boolean(card),questionCount=detail?.questions.length??0,reportCount=detail?.reports.length??0,commentCount=detail?.comments?.filter(comment=>comment.kind!=="note").length??0;
 useEffect(()=>{
  if(!scroll.current)return;
  const previous=previousTimeline.current;
  if(tab==="comments"&&(!previous||previous.cardId!==cardId||previous.tab!==tab||questionCount>previous.questions||reportCount>previous.reports||commentCount>previous.comments))scroll.current.scrollTop=scroll.current.scrollHeight;
  previousTimeline.current={cardId,tab,questions:questionCount,reports:reportCount,comments:commentCount};
 },[cardId,tab,cardAvailable,questionCount,reportCount,commentCount]);
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
 const answer=async(questionId:string,text:string):Promise<boolean>=>{
  // 선택지는 한 번 누르면 바로 간다. 덧붙일 말은 보낸 뒤 입력창의 「덧붙이기」 대상으로 받는다.
  // 답 저장 중에 카드 상세가 닫히면 늦게 온 성공 응답이 새 화면의 대상을 되살리지 않는다.
  const generation=cardQuestionTargetGeneration(questionScope);
  setPending(true);
  try {await useCardStore.getState().mutate(cardId,`/questions/${encodeURIComponent(questionId)}/answer`,cardQuestionChoiceAnswer(text),"POST",t);if(text!=="했어"&&cardQuestionTargetGeneration(questionScope)===generation)setCardQuestionTarget(questionScope,{kind:"append",questionId,label:text});return true;} // i18n-ignore: 부탁을 마쳤음을 나타내는 응답 값.
  catch {return false;} finally {setPending(false);}
 };
 const openQuestion=detail?.questions.find(isOpenCardQuestion);
 const questionHandlers={
  onAskBack:(question:{id:string})=>{setTargetItemId(null);setCardQuestionTarget(questionScope,{kind:"ask",questionId:question.id},true);},
  onAnswerFreely:()=>{setTargetItemId(null);setCardQuestionTarget(questionScope,null,true);},
 };
 const submit=async(comment:string)=>{
  if(!comment.trim()||pending)return false;
  const itemId=targetItemId;
  const qTarget=validTarget;
  if(sampleDetail){
   const saved:CardComment={id:crypto.randomUUID(),cardId,authorKind:"user",authorId:"sample",sessionId:null,kind:"comment",...(itemId===null?{}:{itemId}),body:comment.trim(),createdAt:new Date().toISOString()};
   updateSample(current=>({...current,card:{...current.card,items:itemId===null?current.card.items:current.card.items?.map(item=>item.id===itemId?{...item,state:"doing",confirmed:null,fixOpen:item.fixOpen+1,display:"fix"}:item)},
    comments:[...(current.comments??[]),saved]}));
   setTargetItemId(null);setSentNotice(true);setNoticeVersion(value=>value+1);if(tab!=="comments")setUnreadComments(true);return true;
  }
  setPending(true);
  try {
   if(itemId===null&&qTarget)await useCardStore.getState().addComment(cardId,comment.trim(),cardMutationKey(),undefined,qTarget.questionId,t);
   else if(itemId===null&&openQuestion)await useCardStore.getState().mutate(cardId,`/questions/${encodeURIComponent(openQuestion.id)}/answer`,cardQuestionTextAnswer(comment.trim()),"POST",t);
   else await useCardStore.getState().addComment(cardId,comment.trim(),cardMutationKey(),itemId??undefined,undefined,t);
   setTargetItemId(null);clearCardQuestionTarget(questionScope);setSentNotice(true);setNoticeVersion(value=>value+1);if(tab!=="comments")setUnreadComments(true);
   return true;
  } catch {return false;} finally {setPending(false);}
 };
 // 포커스 요청은 그 요청을 만든 카드에 묶는다. 카드가 바뀐 뒤 이전 카드의 요청이 새 입력창에 닿지 않는다.
 const requestFocus=(amount=1)=>setFocusRequest(current=>current.cardId===cardId?{cardId,value:current.value+amount}:{cardId,value:amount});
 const focusRequestForCard=focusRequest.cardId===cardId?focusRequest.value:0;
 const chooseTargetItem=(itemId:number)=>{
  setTargetItemId(itemId);setSentNotice(false);requestFocus();
 };
 const clearQuestionTarget=()=>{
  requestFocus(questionTarget.focus+1);clearCardQuestionTarget(questionScope);
 };
 const changeTab=(next:"items"|"comments"|"sessions"|"notes")=>{
  setTab(next);
  if(next==="comments")setUnreadComments(false);
 };
 const confirmItem=async(itemId:number,confirmed:boolean)=>{
  if(sampleDetail){
   updateSample(current=>({...current,card:{...current.card,items:current.card.items?.map(item=>item.id===itemId
    ?confirmed?{...item,state:"done",confirmed:{at:new Date().toISOString(),rev:item.rev},display:"confirmed"}
     :{...item,state:"doing",confirmed:null,display:"changed",reopened:t("cards.sampleUnconfirmed")}:item)}}));
   return;
  }
  await useCardStore.getState().confirmItem(cardId,itemId,confirmed,t);
 };
 const complete=async()=>{
  if(!card || pending)return;
  if(sampleDetail){updateSample(current=>({...current,card:{...current.card,status:"done"}}));onClose();return;}
  setPending(true);
  try {await useCardStore.getState().mutate(cardId,"/status",{status:"done",expectedVersion:card.version},"POST",t);onClose();}
  catch {} finally {setPending(false);}
 };
 if(!card)return error ? <div className="v3-detail-section" role="alert">{error}</div>
  : <div className="v3-detail-pane v3-card-detail border border-glass-border glass-strong glass-chrome lg-rim"><FrameLoading label={t("cards.loadingCards")}/></div>;
 const statusControl:CardStatusControl={pending,
  assignment:sampleDetail?dialoguesAssignment:undefined,folders,
  saveSettings:sampleDetail?async(value)=>{const saved={...card,folderId:value.folderId,nodeId:value.nodeId,assigneeAgentId:value.agentId,modelPreset:value.modelPreset,version:card.version+1};updateSample(current=>({...current,card:saved}));return saved;}:undefined,
  load:()=>sampleDetail ? Promise.resolve(activeSample!) : useCardStore.getState().loadCard(cardId,t),
  change:async(latest,status,reason)=>{if(sampleDetail)updateSample(current=>({...current,card:{...current.card,...latest,status,...(status==="running"?{assigneeKind:"session",assigneeSessionId:current.sessions[0]?.sessionId??"sample-session"}: {})}}));else if(status==="running")await useCardStore.getState().execute(cardId,latest.version,t);else await useCardStore.getState().mutate(cardId,"/status",{status,expectedVersion:latest.version,...(reason?{reason}:{})},"POST",t);},
  changeColor:async(latest,color:CardColor)=>{if(sampleDetail)updateSample(current=>({...current,card:{...current.card,color,version:latest.version+1}}));else await useCardStore.getState().mutate(cardId,"",{color,expectedVersion:latest.version},"PATCH",t);},
 };
 const dockStyle={"--v3-card-dock-height":`${dockHeight}px`} as CSSProperties;
 const tabLabel=(short:string, full:string)=>short===full?full:
  <><span aria-hidden="true">{short}</span><span className="sr-only">{full}</span></>;
 const tabs=[
  ["items",<span className="v3-card-tab-label">{tabLabel(t("cards.checkItemsTab"),t("cards.checkItems"))}{itemSummary.toReviewCount>0?<span className="v3-card-tab-count">{itemSummary.toReviewCount}</span>:null}</span>],
  ["comments",<span className="v3-card-tab-label">{tabLabel(t("cards.commentTab"),t("cards.comment"))}{unreadComments?<span className="v3-card-tab-dot" aria-label={t("cards.newComment")}/>:null}</span>],
  ["sessions",<span className="v3-card-tab-label">{tabLabel(t("cards.sessionTab"),t("cards.session"))}{detail?.sessions.length?<span className="v3-card-tab-total">{detail.sessions.length}</span>:null}</span>],
  ["notes",<span className="v3-card-tab-label">{t("cards.notes")}{detail?.notes?.length?<span className="v3-card-tab-total">{detail.notes.length}</span>:null}</span>],
 ] as const;
 return <article ref={surface} className="v3-detail-pane v3-card-detail border border-glass-border glass-strong glass-chrome lg-rim" data-liquid-glass-webgl={webglActive?"true":undefined} data-testid="card-detail">
  <header className="v3-folder-header v3-workspace-toolbar v3-detail-gutter">
   <DashboardIconCap data-card-close label={t("cards.closeCard")} onClick={onClose}><ArrowLeft className="h-4 w-4"/></DashboardIconCap>
   <FolderTitleEditor leading={<CardStatusPicker sampleExecution={sampleExecution} ref={statusPicker} card={card} onOpen={()=>{}} control={statusControl}/>} variant="card" title={card.title} headingLevel={1} onRename={async title=>{if(sampleDetail)updateSample(current=>({...current,card:{...current.card,title}}));else await useCardStore.getState().mutate(cardId,"",{title,expectedVersion:card.version},"PATCH",t);}}/>
   <div className="v3-folder-header-actions" data-complete-emphasis={allChecked||undefined}>
    <CardStatusPicker trigger="more" card={card} onOpen={()=>{}} control={statusControl} sampleExecution={sampleExecution}/>
    <DashboardIconCap size="small" label={actionLabel} disabled={pending||execution?.phase==='pending'} onClick={()=>{if(!allChecked&&(execution||startable))statusPicker.current?.request('running');else void complete();}}>{execution?.phase==='pending'?<LoaderCircle className="h-4 w-4 animate-spin"/>:allChecked?<Check className="h-4 w-4"/>:execution?<RotateCw className="h-4 w-4"/>:startable?<Play className="h-4 w-4"/>:<Check className="h-4 w-4"/>}</DashboardIconCap>
   </div>
  </header>
  {!card.assigneeSessionId?<div className="v3-detail-gutter v3-task-detail-content v3-card-context">
   <section className="v3-detail-section"><CardExecutionSettings assignment={sampleDetail?dialoguesAssignment:undefined} card={card} folders={folders} onSave={sampleDetail?async(value)=>{const saved={...card,folderId:value.folderId,nodeId:value.nodeId,assigneeAgentId:value.agentId,modelPreset:value.modelPreset,version:card.version+1};updateSample(current=>({...current,card:saved}));return saved;}:undefined}/></section>
  </div>:null}
  {card.dependsOn?.length?<div className="v3-detail-gutter v3-task-detail-content v3-card-dependencies"><section className="v3-detail-section">
   <div className="v3-detail-section-head"><h3>{t("cards.dependencies")}</h3><span>{card.dependsOn.filter(dep=>dep.met).length}/{card.dependsOn.length}</span></div>
   <div className="v3-card-dependency-list">{card.dependsOn.map(dep=><Button key={dep.id} variant="outline" className="v3-card-dependency-row" data-stopped={cardDependencyStopReason(dep)!==null||undefined} onClick={()=>openCard(dep.id,"overlay")}>
    <span className="v3-card-dependency-number">{dep.number==null?"":`#${dep.number}`}</span><span className="v3-card-dependency-title">{dep.title}</span><StatusChip tone={cardDependencyStatus(dep,t).tone} label={cardDependencyStatus(dep,t).label}/><ChevronRight className="h-4 w-4" aria-hidden="true"/>
   </Button>)}</div></section></div>:null}
  {card.now?<div key={cardId} className="v3-detail-gutter v3-card-now-slot"><CardNowPanel now={card.now} nowHistory={detail?.nowHistory} itemsCount={card.items?.length??0} activeCount={itemSummary.activeCount} onComplete={()=>void complete()} pending={pending||execution?.phase==='pending'}/></div>:null}
  <div className="v3-detail-gutter v3-card-tabs"><DetailTabs id={tabId} label={t("cards.viewCard")} panelId={`${tabId}-panel`} variant="card" tabs={tabs} value={tab} onChange={changeTab}/></div>
  {execution && execution.phase!=="pending"?<p role={execution.phase==="error"?"alert":"status"} className="v3-card-error">{execution.message}</p>:null}
  {error?<p role="alert" className="v3-card-error">{error}</p>:null}
  <div className="v3-detail-scroll v3-card-panel-scroll v3-detail-gutter" data-card-active-tab={tab} ref={scroll} style={dockStyle} role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-${tab}`}>
   <div className="v3-task-detail-content">
    <section className="v3-detail-section" data-card-tab-panel="items" hidden={tab!=="items"}>
     <CardCheckItems key={cardId} items={card.items} pendingConfirmations={pendingConfirmations} onConfirmChange={confirmItem} onTargetItem={chooseTargetItem}/>
    </section>
    <section className="v3-detail-section" data-card-tab-panel="comments" hidden={tab!=="comments"}>
     <CardTimeline key={cardId} card={card} detail={detail} portraitUrl={portrait} userPortraitUrl={user?.picture??""} pending={pending} onAnswer={(id,text)=>answer(id,text)} questionHandlers={questionHandlers}/>
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
   {targetItemId!==null?<div className="v3-card-target-notice" role="status"><span>{t("cards.itemTarget", {number:targetItemId,title:targetItem?.title??t("cards.item")})}</span><button type="button" aria-label={t("cards.clearCommentTarget")} onClick={()=>{setTargetItemId(null);requestFocus();}}>{t("cards.clear")}</button></div>:null}
   {targetItemId===null&&validTarget?<CardQuestionNotice label={validTarget.kind==="ask"?t("cards.askBack"):t("cards.appendTo", {answer:validTarget.label})} onClear={clearQuestionTarget}/>:null}
   {sentNotice?<div className="v3-card-sent-notice" role="status">{t("cards.sent")} <button type="button" onClick={()=>changeTab("comments")}>{t("cards.viewInComments")}</button></div>:null}
   <CardCommentInput uploadController={sampleDetail?sampleUpload:undefined} key={cardId} cardId={cardId} nodeId={nodeId} sessionId={card.assigneeSessionId} pending={pending} focusRequest={focusRequestForCard+questionTarget.focus} onSend={submit}
    kind={targetItemId===null&&(validTarget||openQuestion)?"answer":"comment"} placeholder={targetItemId!==null?t("cards.comment"):validTarget?.kind==="ask"?t("cards.followUpPlaceholder"):validTarget?.kind==="append"?t("cards.appendPlaceholder"):openQuestion?t("cards.answerFreely"):t("cards.comment")}/>
  </div>
 </article>;
}
