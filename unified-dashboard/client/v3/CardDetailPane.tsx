import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { DashboardIconCap, MarkdownContent, useGlassSurface, type CatalogFolder, type SessionSummary } from "@seosoyoung/soul-ui";
import { CustomViewIframe } from "@seosoyoung/soul-ui/custom-view/CustomViewRenderer";
import { ArrowLeft, FileText, History, ListChecks, MessageCircle, MoreHorizontal, ScrollText } from "lucide-react";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import { CardActions, CardStatusChip } from "./CardActions";
import { FolderTitleEditor } from "./FolderTitleEditor";
import { SectionNavigation } from "./FolderSectionNavigation";
import { RichSessionRow } from "./RichSessionRow";
import { CardQuestionView } from "./CardQuestionView";
import { CardMenu } from "./CardMenu";
import "./v3-cards.css";
const sections=[{id:"request",label:"원문",accessibleLabel:"원문",Icon:FileText},{id:"brief",label:"경과",accessibleLabel:"해석과 경과",Icon:ListChecks},{id:"reports",label:"보고",accessibleLabel:"보고",Icon:ScrollText},{id:"questions",label:"질문",accessibleLabel:"질문",Icon:MessageCircle},{id:"sessions",label:"세션",accessibleLabel:"세션",Icon:History}] as const;
export function CardDetailPane({cardId,folders,onClose,onOpenSession,placement="inline",focus,scrollContainerRef}: {cardId:string;folders:readonly CatalogFolder[];onClose():void;onOpenSession(session:SessionSummary):void;placement?:"inline"|"overlay";focus?:string|null;scrollContainerRef?:RefObject<HTMLDivElement|null>}) {
 const card=useCardStore(s=>s.byId[cardId]);const detail=useCardStore(s=>s.details[cardId]);const error=useCardStore(s=>s.errors[cardId]);
 const scroll=useRef<HTMLDivElement>(null),surface=useRef<HTMLElement>(null);
 const activeScroll=placement==="inline"&&scrollContainerRef?scrollContainerRef:scroll;
 const request=useRef<HTMLElement>(null),brief=useRef<HTMLElement>(null),reports=useRef<HTMLElement>(null),questions=useRef<HTMLElement>(null),sessions=useRef<HTMLElement>(null);
 const refs=useMemo(()=>({request,brief,reports,questions,sessions}),[]);
 const [menu,setMenu]=useState<{x:number;y:number}|null>(null);
 const glass=useGlassSurface(surface,{enabled:placement==="overlay"});
 useEffect(()=>{void useCardStore.getState().loadCard(cardId).catch(()=>undefined);},[cardId]);
 useEffect(()=>{if(focus==="questions"&&detail)questions.current?.scrollIntoView({block:"start"});},[detail,focus]);
 if(!card)return <div className="v3-detail-section" role={error?"alert":undefined}>{error??"카드를 불러오는 중…"}</div>;
 const linked=detail?.sessions.map(s=>({agentSessionId:s.sessionId,displayName:s.displayName,nodeId:s.nodeId,agentId:s.agentId,status:s.status,createdAt:s.createdAt,eventCount:0,cardId:s.cardId}))??[];
 return <article ref={surface} className={`v3-detail-pane v3-card-detail${placement==="inline"?" v3-detail-pane--inline":" border border-glass-border glass-strong glass-chrome lg-rim"}`} data-liquid-glass-webgl={glass?"true":undefined} data-testid="card-detail">
  <header className={`v3-folder-header${placement==="inline"?" v3-inline-folder-header":" v3-workspace-toolbar"}`}>
   <DashboardIconCap label="카드 닫기" onClick={onClose}><ArrowLeft className="h-4 w-4"/></DashboardIconCap><CardStatusChip card={card}/>
   <FolderTitleEditor title={card.title} headingLevel={1} onRename={async title=>{await useCardStore.getState().mutate(cardId,"",{title,expectedVersion:card.version},"PATCH");}}/>
   <div className="v3-folder-header-actions"><CardActions card={card} onAnswer={()=>questions.current?.scrollIntoView({block:"start"})}/><DashboardIconCap label="카드 메뉴" onClick={e=>setMenu({x:e.clientX,y:e.clientY})}><MoreHorizontal className="h-4 w-4"/></DashboardIconCap></div>
  </header>
  {error?<p role="alert" className="v3-card-error">{error}</p>:null}
  <CardMenu card={card} folders={folders} target={menu} onClose={()=>setMenu(null)}/>
  <div className="v3-detail-scroll" ref={scroll}><div className="v3-task-detail-layout">
   <SectionNavigation scrollRef={activeScroll} sectionRefs={refs} sections={sections} ariaLabel="카드 섹션"/>
   <div className="v3-task-detail-content">
    <section className="v3-detail-section" ref={request} data-card-section="request"><div className="v3-detail-section-head"><h3>요청 원문</h3></div><details open><summary>원문 보기</summary><div className="v3-card-request"><CardRequestContent request={card.request}/></div></details></section>
    <section className="v3-detail-section" ref={brief} data-card-section="brief"><div className="v3-detail-section-head"><h3>해석과 경과</h3></div><MarkdownContent content={card.brief??""} codeBlockLayout="document"/></section>
    <section className="v3-detail-section" ref={reports} data-card-section="reports"><div className="v3-detail-section-head"><h3>보고</h3></div>{detail?.reports.map((report,index)=><details key={report.id} data-report-id={report.id} open={index===0}><summary>{report.title} · {new Date(report.createdAt).toLocaleString("ko-KR")}</summary>{report.format==="html"?<CustomViewIframe html={report.body} title={report.title} className="v3-card-report-html"/>:<MarkdownContent content={report.body} codeBlockLayout="document"/>}</details>)}</section>
    <section className="v3-detail-section" ref={questions} data-card-section="questions"><div className="v3-detail-section-head"><h3>질문</h3></div>{detail?.questions.map(q=><CardQuestionView key={q.id} cardId={cardId} question={q}/>)}</section>
    <section className="v3-detail-section" ref={sessions} data-card-section="sessions"><div className="v3-detail-section-head"><h3>세션</h3></div>{linked.length===0?<p className="v3-card-request">세션 없음</p>:<div className="v3-run-list">{linked.map(s=><RichSessionRow key={s.agentSessionId} session={s} onOpen={onOpenSession}/>)}</div>}</section>
   </div>
  </div></div>
 </article>;
}

export function cardRequestMarkdown(request: string): string {
 return request.replace(/^첨부: (.+)\((https?:\/\/[^\s]+)\)$/gm, (_, name: string, url: string) => {
  const label = name.replace(/[\[\]\\]/g, "\\$&");
  const image = /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(name);
  return `첨부: ${image ? "!" : ""}[${label}](${url})`;
 });
}

function CardRequestContent({request}: {request: string}) {
 return request.split(/(^첨부: .+\(https?:\/\/[^\s]+\)$)/m).map((part,index)=>
  part.startsWith("첨부: ") && cardRequestMarkdown(part)!==part
   ? <MarkdownContent key={index} content={cardRequestMarkdown(part)} codeBlockLayout="document"/>
   : <span key={index}>{part}</span>);
}
