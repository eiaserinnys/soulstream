import { useState, type ReactNode } from "react";
import { Button, MarkdownContent } from "@seosoyoung/soul-ui";
import { UserMessage } from "@seosoyoung/soul-ui/components/chat/UserMessage";
import { AssistantMessage } from "@seosoyoung/soul-ui/components/chat/AssistantMessage";
import { CustomViewIframe } from "@seosoyoung/soul-ui/custom-view/CustomViewRenderer";
import type { ChatMessage } from "@seosoyoung/soul-ui/lib/flatten-tree";
import type { CardDetail, CardReport, CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { cardRequestMarkdown } from "./card-request-markdown";

export function CardTimeline({card,detail,portraitUrl,userPortraitUrl,onAnswer,pending}: {
 card: CardRow; detail?: CardDetail; portraitUrl: string | null; userPortraitUrl?: string | null;
 onAnswer(questionId:string,answer:string):void; pending:boolean;
}) {
 const entries: {id:string;at:string;kind:string;role:"user"|"assistant";spoken?:boolean;body:ReactNode}[] = [
  {id:"request",at:card.createdAt,kind:"지시",role:"user",body:<RequestPreview request={card.request}/>},
  ...(detail?.questions ?? []).flatMap(q=>[
   {id:`q-${q.id}`,at:q.askedAt,kind:"질문",role:"assistant" as const,body:<><MarkdownContent content={q.text}/>{!q.answer && q.options?.length ? <div className="v3-card-answer-options">{q.options.map(option=><Button key={option} variant="outline" disabled={pending} onClick={()=>onAnswer(q.id,option)}>{option}</Button>)}</div>:null}</>},
   ...(q.answer ? [{id:`a-${q.id}`,at:q.answeredAt ?? q.askedAt,kind:"답",role:"user" as const,body:<MarkdownContent content={q.answer}/>}]:[]),
  ]),
  ...(detail?.reports ?? []).map(report=>({id:report.id,at:report.createdAt,kind:"보고",role:"assistant" as const,body:<ReportPreview report={report}/>})),
  ...(detail?.comments ?? []).map(comment=>({id:comment.id,at:comment.createdAt,kind:"커멘트",spoken:comment.kind==="spoken",role:comment.authorKind==="agent" ? "assistant" as const:"user" as const,body:<MarkdownContent content={comment.body}/>})),
 ];
 entries.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
 return <div className="v3-card-timeline">{entries.map(entry=>{
  const msg:ChatMessage={id:entry.id,treeNodeId:entry.id,treeNodeType:"card",role:entry.role,content:""};
  const header=<div className="v3-card-bubble-kind"><strong>{entry.kind}</strong>{entry.spoken?<span>대화에서</span>:null}<time dateTime={entry.at}>{entry.at ? new Date(entry.at).toLocaleTimeString("ko-KR",{hour:"2-digit",minute:"2-digit"}) : ""}</time></div>;
  return <div key={entry.id} data-card-entry={entry.kind} data-card-role={entry.role}>
   {entry.role==="user" ? <UserMessage msg={msg} header={header} portraitUrl={userPortraitUrl}>{entry.body}</UserMessage> : <AssistantMessage msg={msg} header={header} portraitUrl={portraitUrl}>{entry.body}</AssistantMessage>}
  </div>;
 })}</div>;
}
function RequestPreview({request}:{request:string}) {
 const [expanded,setExpanded]=useState(false);
 return <><div className={expanded ? undefined:"v3-card-three-lines"}><MarkdownContent content={cardRequestMarkdown(request)}/></div><button type="button" className="v3-card-more" aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)}>{expanded ? "접기":"더 보기"}</button></>;
}
function ReportPreview({report}:{report:CardReport}) {
 const images=report.format==="markdown" ? [...report.body.matchAll(/!\[([^\]]*)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)].slice(0,2).map(match=>({alt:match[1],src:match[2]})) : [];
 const summary=report.format==="html" ? report.body.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,"").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,"").replace(/<[^>]+>/g," ").trim() : report.body;
 return <div data-report-id={report.id}><strong className="v3-card-report-title">{report.title}</strong><div className="v3-card-three-lines"><MarkdownContent content={summary}/></div>
  {images.length ? <div className="v3-card-report-thumbnails">{images.map((img,i)=><img key={i} src={img.src} alt={img.alt} loading="lazy"/>)}</div>:null}
  <details><summary>자세히</summary>{report.format==="html" ? <CustomViewIframe html={report.body} title={report.title} className="v3-card-report-html"/>:<MarkdownContent content={report.body} codeBlockLayout="document"/>}</details>
 </div>;
}
