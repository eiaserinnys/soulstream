import { useChatTypography } from "@seosoyoung/soul-ui/components/chat/useChatTypography";
import { useState, type HTMLAttributes, type ReactNode } from "react";
import { Button, MarkdownContent, Dialog, DialogPopup, DialogTitle } from "@seosoyoung/soul-ui";
import { UserMessage } from "@seosoyoung/soul-ui/components/chat/UserMessage";
import { AssistantMessage } from "@seosoyoung/soul-ui/components/chat/AssistantMessage";
import { MarkdownImage } from "@seosoyoung/soul-ui/components/MarkdownImage";
import { CustomViewIframe } from "@seosoyoung/soul-ui/custom-view/CustomViewRenderer";
import type { ChatMessage } from "@seosoyoung/soul-ui/lib/flatten-tree";
import type { CardDetail, CardReport, CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { cardRequestMarkdown } from "./card-request-markdown";

export function CardTimeline({card,detail,portraitUrl,userPortraitUrl,onAnswer,pending,initialImage}: {
 initialImage?:{src:string;alt:string};
 card:CardRow;detail?:CardDetail;portraitUrl:string|null;userPortraitUrl?:string|null;
 onAnswer(questionId:string,answer:string):void;pending:boolean;
}) {
 const {chatTypographyStyle}=useChatTypography();
 const [expanded,setExpanded]=useState<ReadonlySet<string>>(()=>new Set());
 const [image,setImage]=useState<{src:string;alt:string}|null>(initialImage??null);
 const openImage=(src:string,alt:string)=>setImage({src,alt});
 const entries:{id:string;at:string;kind:string;role:"user"|"assistant";spoken?:boolean;collapsible?:boolean;body:ReactNode}[]=[
  {id:"request",at:card.createdAt,kind:"지시",role:"user",collapsible:true,body:<RequestPreview request={card.request} attachments={card.attachments??[]} expanded={expanded.has("request")} onImageClick={openImage}/>},
  ...(detail?.questions??[]).flatMap(q=>[
   {id:`q-${q.id}`,at:q.askedAt,kind:"질문",role:"assistant" as const,body:<><MarkdownContent content={q.text} onImageClick={openImage}/>{!q.answer&&q.options?.length?<div className="v3-card-answer-options">{q.options.map(option=><Button key={option} variant="outline" disabled={pending} onClick={()=>onAnswer(q.id,option)}>{option}</Button>)}</div>:null}</>},
   ...(q.answer?[{id:`a-${q.id}`,at:q.answeredAt??q.askedAt,kind:"답",role:"user" as const,body:<MarkdownContent content={q.answer} onImageClick={openImage}/>}]:[]),
  ]),
  ...(detail?.reports??[]).map(report=>({id:report.id,at:report.createdAt,kind:"보고",role:"assistant" as const,collapsible:true,body:<ReportPreview report={report} expanded={expanded.has(report.id)} onImageClick={openImage}/>})),
  ...(detail?.comments??[]).map(comment=>({id:comment.id,at:comment.createdAt,kind:"커멘트",spoken:comment.kind==="spoken",role:comment.authorKind==="agent"?"assistant" as const:"user" as const,body:<MarkdownContent content={comment.body} onImageClick={openImage}/>})),
 ];
 entries.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
 const toggle=(id:string)=>setExpanded(current=>{const next=new Set(current);if(next.has(id))next.delete(id);else next.add(id);return next;});
 return <><div className="v3-card-timeline v3-chat-surface" style={chatTypographyStyle}>{entries.map(entry=>{
  const msg:ChatMessage={id:entry.id,treeNodeId:entry.id,treeNodeType:"card",role:entry.role,content:""};
  const header=<div className="v3-card-bubble-kind"><strong>{entry.kind}</strong>{entry.spoken?<span>대화에서</span>:null}<time dateTime={entry.at}>{entry.at?new Date(entry.at).toLocaleTimeString("ko-KR",{hour:"2-digit",minute:"2-digit"}):""}</time></div>;
  const bubbleProps:HTMLAttributes<HTMLDivElement>|undefined=entry.collapsible?{
   role:"button",tabIndex:0,className:"outline-none focus-visible:ring-2 focus-visible:ring-ring","aria-expanded":expanded.has(entry.id),
   onClick:event=>{if(!(event.target as Element).closest("a,button,input,iframe"))toggle(entry.id);},
   onKeyDown:event=>{if(event.currentTarget===event.target&&(event.key==="Enter"||event.key===" ")){event.preventDefault();toggle(entry.id);}},
  }:undefined;
  return <div key={entry.id} data-card-entry={entry.kind} data-card-role={entry.role}>
   {entry.role==="user"?<UserMessage msg={msg} header={header} portraitUrl={userPortraitUrl} bubbleProps={bubbleProps}>{entry.body}</UserMessage>:<AssistantMessage msg={msg} header={header} portraitUrl={portraitUrl} bubbleProps={bubbleProps}>{entry.body}</AssistantMessage>}
  </div>;
 })}</div><Dialog open={Boolean(image)} onOpenChange={open=>{if(!open)setImage(null);}}><DialogPopup>
  <DialogTitle className="sr-only">{image?.alt||"이미지"}</DialogTitle>{image?<img src={image.src} alt={image.alt} className="max-w-full object-contain"/>:null}
 </DialogPopup></Dialog></>;
}
function RequestPreview({request,attachments,expanded,onImageClick}:{request:string;attachments:CardRow["attachments"];expanded:boolean;onImageClick(src:string,alt:string):void}) {
 return <><div className={expanded?undefined:"v3-card-three-lines"}><MarkdownContent content={cardRequestMarkdown(request)} onImageClick={onImageClick}/></div>{attachments.length?<div className="v3-card-report-thumbnails">{attachments.map(attachment=>{
  const src=`/api/attachments/files?${new URLSearchParams({nodeId:attachment.nodeId,path:attachment.path})}`;
  return attachment.mimeType.startsWith("image/")?<MarkdownImage key={src} src={src} alt={attachment.name} onOpen={onImageClick}/>:<a key={src} href={src} target="_blank" rel="noreferrer">{attachment.name}</a>;
 })}</div>:null}<span className="v3-card-collapse-hint">{expanded?"접기":"더 보기"}</span></>;
}
function ReportPreview({report,expanded,onImageClick}:{report:CardReport;expanded:boolean;onImageClick(src:string,alt:string):void}) {
 const images=report.format==="markdown"?[...report.body.matchAll(/!\[([^\]]*)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)].slice(0,2).map(match=>({alt:match[1],src:match[2]})):[];
 const summary=report.format==="html"?report.body.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,"").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,"").replace(/<[^>]+>/g," ").trim():report.body.replace(/!\[[^\]]*\]\([^)]*\)/g,"");
 return <div data-report-id={report.id}><strong className="v3-card-report-title">{report.title}</strong>
  {expanded?(report.format==="html"?<CustomViewIframe html={report.body} title={report.title} className="v3-card-report-html"/>:<MarkdownContent content={report.body} codeBlockLayout="document" onImageClick={onImageClick}/>):<><div className="v3-card-three-lines"><MarkdownContent content={summary}/></div>
   {images.length?<div className="v3-card-report-thumbnails">{images.map((img,i)=><MarkdownImage key={i} src={img.src} alt={img.alt} onOpen={onImageClick}/>)}</div>:null}</>}
  <span className="v3-card-collapse-hint">{expanded?"접기":"자세히"}</span>
 </div>;
}
