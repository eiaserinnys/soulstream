import { dictionaries } from "@soulstream/i18n";
import { formatTime } from "./CardCheckItemRow";
import { useTranslation } from "react-i18next";
import { useChatTypography } from "@seosoyoung/soul-ui/components/chat/useChatTypography";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type HTMLAttributes, type ReactNode } from "react";
import { Button, MarkdownContent, useInternalLinkClick } from "@seosoyoung/soul-ui";
import { UserMessage } from "@seosoyoung/soul-ui/components/chat/UserMessage";
import { AssistantMessage } from "@seosoyoung/soul-ui/components/chat/AssistantMessage";
import { MarkdownImage } from "@seosoyoung/soul-ui/components/MarkdownImage";
import { CustomViewIframe } from "@seosoyoung/soul-ui/custom-view/CustomViewRenderer";
import type { ChatMessage } from "@seosoyoung/soul-ui/lib/flatten-tree";
import { isImagePreviewMimeType, mimeTypeForFileName } from "../../../packages/wire-schema/src/attachments";
import { attachmentContentUrl, contextualLegacyUrl, type ChatAttachmentItem } from "@seosoyoung/soul-ui/lib/chat-attachment-model";
import type { CardDetail, CardQuestion, CardReport, CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { cardRequestMarkdown } from "./card-request-markdown";
import { CardQuestionActions, CardQuestionBody, cardQuestionDetailView } from "./CardQuestionBlock";
import { CardImageViewer, type CardAttachmentStatus } from "./CardImageViewer";
import { type AttachmentReadContext, attachmentUrlHasContext, cardAttachmentSelectionFromUrl, cardLegacyAttachmentSelectionFromUrl } from "./card-attachment-selection";
import { failedReference, loadAttachmentAsset, unavailableItem, type AttachmentLoadResult, type AttachmentPlaceholderReference } from "./attachment-asset-loader";

const timelineLabels = {
 request:"instructions",
 ask:"cardRequest",
 question:"question",
 answer:"answer",
 report:"report",
 comment:"comment",
} as const;
type TimelineKind = keyof typeof timelineLabels;
type MarkdownSourceLink = NonNullable<ComponentProps<typeof MarkdownContent>["sourceLinkComponent"]>;

export type CardQuestionHandlers={onAskBack(question:CardQuestion):void;onAnswerFreely(question:CardQuestion):void};
export function CardTimeline({card,detail,portraitUrl,userPortraitUrl,onAnswer,pending,initialImage,commentsOnly=false,questionHandlers}: {
 commentsOnly?:boolean;
 /** 카드 #1197: 새 질문 장을 쓴다. 열린 질문은 커멘트 탭 맨 아래, 입력창 바로 위에 선다. */
 questionHandlers?:CardQuestionHandlers;
 initialImage?:{src:string;alt:string};
 card:CardRow;detail?:CardDetail;portraitUrl:string|null;userPortraitUrl?:string|null;
 onAnswer(questionId:string,answer:string):boolean|void|Promise<boolean|void>;pending:boolean;
}) {
 const {t,i18n}=useTranslation();
 const {chatTypographyStyle}=useChatTypography();
 const internalLinkClick=useInternalLinkClick();
 const timeline=useRef<HTMLDivElement>(null);
 const [overflowingComments,setOverflowingComments]=useState<ReadonlySet<string>>(()=>new Set());
 const [expanded,setExpanded]=useState<ReadonlySet<string>>(()=>new Set());
 const [image,setImage]=useState<{src:string;alt:string;attachment?:ChatAttachmentItem}|null>(initialImage??null);
 const [imageAttachments,setImageAttachments]=useState<readonly ChatAttachmentItem[]>([]);
 const [attachmentStates,setAttachmentStates]=useState<Record<string,AttachmentLoadResult["status"]>>({});
 const openedReferences=useRef<readonly CardAttachmentReference[]>([]);
 const imageTrigger=useRef<HTMLElement|null>(null);
 const attachmentRequest=useRef<AbortController|null>(null);
 const origin=typeof window==="undefined"?"http://localhost":window.location.origin;

 const openImage=useCallback((src:string,alt:string,trigger?:HTMLElement)=>{
  attachmentRequest.current?.abort();
  imageTrigger.current=trigger??(document.activeElement instanceof HTMLElement?document.activeElement:null);
  setImage({src,alt});
  setImageAttachments([]);
  setAttachmentStates({});
 },[]);
 const openReference=useCallback(async(reference:CardAttachmentReference,references:readonly CardAttachmentReference[],trigger?:HTMLElement)=>{
  attachmentRequest.current?.abort();
  const controller=new AbortController();
  attachmentRequest.current=controller;
  openedReferences.current=references;
  imageTrigger.current=trigger??(document.activeElement instanceof HTMLElement?document.activeElement:null);
  const placeholders=references.map(item=>unavailableItem(placeholderReference(item),"unavailable",item.kind==="image"?"image":"info"));
  const placeholder=placeholders.find(item=>item.key===reference.key)!;
  setImageAttachments(placeholders);
  setAttachmentStates(Object.fromEntries(references.map(item=>[item.key,{message:t("cards.previewLoading")}])));
  setImage({src:reference.url,alt:reference.label,attachment:placeholder});
  try{
   const results=await Promise.all(references.map(item=>loadCardAttachmentReference(item,controller.signal,t)));
   if(controller.signal.aborted)return;
   const items=results.map(result=>result.item);
   const selected=items.find(item=>item.key===reference.key);
   if(!selected)return;
   setImageAttachments(items);
   setAttachmentStates(Object.fromEntries(results.map(result=>[result.item.key,result.status])));
   setImage({src:selected.previewUrl??selected.originalUrl??reference.url,alt:reference.label,attachment:selected});
  }catch(error){
   if(!controller.signal.aborted)throw error;
  }
 },[t]);
 const retryReference=async(key:string)=>{
  const reference=openedReferences.current.find(item=>item.key===key);
  const controller=attachmentRequest.current;
  if(!reference||!controller||controller.signal.aborted)return;
  setAttachmentStates(current=>({...current,[key]:{message:t("cards.previewLoading")}}));
  try{
   const result=await loadCardAttachmentReference(reference,controller.signal,t);
   if(controller.signal.aborted)return;
   setImageAttachments(current=>current.map(item=>item.key===key?result.item:item));
   setAttachmentStates(current=>({...current,[key]:result.status}));
  }catch(error){if(!controller.signal.aborted)throw error;}
 };
 const closeImage=()=>{
  attachmentRequest.current?.abort();
  attachmentRequest.current=null;
  setImage(null);
  setImageAttachments([]);
  setAttachmentStates({});
  openedReferences.current=[];
  requestAnimationFrame(()=>imageTrigger.current?.focus({preventScroll:true}));
 };
 useEffect(()=>()=>attachmentRequest.current?.abort(),[]);

 // Measure the clamped body so short comments never advertise an expand action.
 useLayoutEffect(()=>{
  if(!commentsOnly)return;
  const bodies=[...timeline.current!.querySelectorAll<HTMLElement>('[data-comment-preview]')];
  const measure=()=>setOverflowingComments(current=>{
   const next=new Set(current);
   for(const body of bodies){
    const id=body.dataset.commentPreview!;
    if(expanded.has(id))continue;
    if(body.scrollHeight>body.clientHeight+1)next.add(id);else next.delete(id);
   }
   return next.size===current.size&&[...next].every(id=>current.has(id))?current:next;
  });
  measure();
  const observer=new ResizeObserver(measure);
  bodies.forEach(body=>observer.observe(body));
  return ()=>observer.disconnect();
 },[commentsOnly,detail,expanded]);

 // Opening the viewer must keep the original Markdown nodes mounted for focus restoration.
 const entries=useMemo(()=>{
 const openMarkdownImage=(src:string,alt:string,references:readonly CardAttachmentReference[],trigger?:HTMLElement)=>{
  const reference=referenceFromUrl(src,card.id,origin,alt,"image",references,t);
  if(!reference){openImage(src,alt,trigger);return;}
  void openReference(reference,ensureReference(references,reference),trigger);
 };
 const requestMarkdown=cardRequestMarkdown(card.request);
 const renderedRequestMarkdown=contextualizeMarkdownAttachmentUrls(requestMarkdown,card.id,origin);
 const requestAttachmentReferences=(card.attachments??[]).map((attachment,index)=>occurrenceReference(legacyAttachmentReference(card.id,attachment,t),`request:${index}`));
 const requestReferences=[...markdownAttachmentReferences(renderedRequestMarkdown,card.id,origin,t),...requestAttachmentReferences];
 const requestLink=sourceLinkComponent(card.id,origin,requestReferences,openReference,internalLinkClick,t,true);
 const entries:{id:string;at:string;shownAt?:string;revised?:boolean;kind:TimelineKind;role:"user"|"assistant";spoken?:boolean;withdrawn?:boolean;collapsible?:boolean;body:ReactNode}[]=[
  {id:"request",at:card.createdAt,kind:"request",role:"user",collapsible:true,body:<RequestPreview markdown={renderedRequestMarkdown} attachments={requestAttachmentReferences} expanded={expanded.has("request")} linkComponent={requestLink} onImageClick={(src:string,alt:string,trigger?:HTMLElement)=>openMarkdownImage(src,alt,requestReferences,trigger)} onOpenAttachment={(reference,trigger)=>void openReference(reference,requestReferences,trigger)}/>},
  ...(detail?.questions??[]).flatMap(q=>{
   const questionMarkdown=contextualizeMarkdownAttachmentUrls(q.text,card.id,origin);
   const questionReferences=markdownAttachmentReferences(questionMarkdown,card.id,origin,t);
   const questionLink=sourceLinkComponent(card.id,origin,questionReferences,openReference,internalLinkClick,t);
   const withdrawn=Boolean(q.withdrawnAt);
   const answerMarkdown=q.answer?contextualizeMarkdownAttachmentUrls(q.answer,card.id,origin):"";
   const answerReferences=markdownAttachmentReferences(answerMarkdown,card.id,origin,t);
   const answerLink=sourceLinkComponent(card.id,origin,answerReferences,openReference,internalLinkClick,t,true);
   if(questionHandlers){
    const view=cardQuestionDetailView(q,detail?.comments??[],card.title);
    return [
     {id:`q-${q.id}`,at:view.open?"9999-12-31T00:00:00Z":(view.revisedAt??q.askedAt),shownAt:view.revisedAt??q.askedAt,revised:Boolean(view.revisedAt),kind:q.kind==="request"?"ask" as const:"question" as const,role:"assistant" as const,withdrawn,body:<div className="v3-card-question-body">
      {view.title?<h3 className="v3-card-question-title">{view.title}</h3>:null}
      <CardQuestionBody view={view} portraitUrl={portraitUrl} userPortraitUrl={userPortraitUrl} pending={pending} layout="columns" onChoose={label=>onAnswer(q.id,label)}/>
      {withdrawn&&q.withdrawalReason?<p className="v3-card-question-withdrawal">{q.withdrawalReason}</p>:null}
      <CardQuestionActions view={view} pending={pending} onAnswerFreely={()=>questionHandlers.onAnswerFreely(q)} onAskBack={()=>questionHandlers.onAskBack(q)} onDone={()=>onAnswer(q.id,"했어" /* i18n-ignore: 부탁을 마쳤음을 나타내는 응답 값. */)} composerVisible/>
     </div>},
     ...(q.answer?[{id:`a-${q.id}`,at:q.answeredAt??q.askedAt,kind:"answer" as const,role:"user" as const,body:<MarkdownContent content={answerMarkdown} onImageClick={(src:string,alt:string,trigger?:HTMLElement)=>openMarkdownImage(src,alt,answerReferences,trigger)} sourceLinkComponent={answerLink}/>}]:[]),
    ];
   }
   return [
    {id:`q-${q.id}`,at:q.askedAt,kind:"question" as const,role:"assistant" as const,withdrawn,body:<><MarkdownContent content={questionMarkdown} onImageClick={(src:string,alt:string,trigger?:HTMLElement)=>openMarkdownImage(src,alt,questionReferences,trigger)} sourceLinkComponent={questionLink}/>{withdrawn&&q.withdrawalReason?<p className="v3-card-question-withdrawal">{q.withdrawalReason}</p>:null}{!withdrawn&&!q.answer&&q.options?.length?<div className="v3-card-answer-options">{q.options.map(option=><Button key={option} variant="outline" disabled={pending} onClick={()=>onAnswer(q.id,option)}>{option}</Button>)}</div>:null}</>},
    ...(q.answer?[{id:`a-${q.id}`,at:q.answeredAt??q.askedAt,kind:"answer" as const,role:"user" as const,body:<MarkdownContent content={answerMarkdown} onImageClick={(src:string,alt:string,trigger?:HTMLElement)=>openMarkdownImage(src,alt,answerReferences,trigger)} sourceLinkComponent={answerLink}/>}]:[]),
   ];
  }),
  ...(detail?.reports??[]).map(report=>{
   const markdownBody=report.format==="markdown"?contextualizeMarkdownAttachmentUrls(report.body,card.id,origin):report.body;
   const references=markdownAttachmentReferences(markdownBody,card.id,origin,t);
   const linkComponent=sourceLinkComponent(card.id,origin,references,openReference,internalLinkClick,t);
   return {id:report.id,at:report.createdAt,kind:"report" as const,role:"assistant" as const,collapsible:true,body:<ReportPreview report={report} markdownBody={markdownBody} expanded={expanded.has(report.id)} references={references} linkComponent={linkComponent} onImageClick={(src:string,alt:string,trigger?:HTMLElement)=>openMarkdownImage(src,alt,references,trigger)}/>};
  }),
  ...(detail?.comments??[]).filter(comment=>comment.kind!=="note"&&comment.questionId==null).map(comment=>{
   const target=comment.itemId===undefined||comment.itemId===null?undefined:(detail?.card.items??card.items)?.find(item=>item.id===comment.itemId);
   const commentMarkdown=contextualizeMarkdownAttachmentUrls(comment.body,card.id,origin);
   const references=markdownAttachmentReferences(commentMarkdown,card.id,origin,t);
   const linkComponent=sourceLinkComponent(card.id,origin,references,openReference,internalLinkClick,t,comment.authorKind!=="agent");
   return {id:comment.id,at:comment.createdAt,kind:"comment" as const,spoken:comment.kind==="spoken",collapsible:commentsOnly&&overflowingComments.has(comment.id),role:comment.authorKind==="agent"?"assistant" as const:"user" as const,
    body:<>{comment.itemId!==undefined&&comment.itemId!==null?<p className="v3-card-comment-target">{t("cards.itemTarget", {number:comment.itemId,title:target?.title??t("cards.item")})}</p>:null}<div data-comment-preview={commentsOnly?comment.id:undefined} className={commentsOnly&&!expanded.has(comment.id)?"v3-card-three-lines":undefined}><MarkdownContent content={commentMarkdown} onImageClick={(src:string,alt:string,trigger?:HTMLElement)=>openMarkdownImage(src,alt,references,trigger)} sourceLinkComponent={linkComponent}/></div>{commentsOnly&&overflowingComments.has(comment.id)?<span className="v3-card-collapse-hint">{expanded.has(comment.id)?t("cards.collapse"):t("cards.showMore")}</span>:null}</>};
  }),
 ];
 return entries.filter(entry=>!commentsOnly||entry.kind==="comment").sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
 },[card,detail,commentsOnly,expanded,overflowingComments,pending,onAnswer,openImage,openReference,origin,internalLinkClick,questionHandlers,t]);
 const toggle=(id:string)=>setExpanded(current=>{const next=new Set(current);if(next.has(id))next.delete(id);else next.add(id);return next;});
 const viewerStatuses:Record<string,CardAttachmentStatus>={};
 for(const [key,status] of Object.entries(attachmentStates)){
  if(status)viewerStatuses[key]={message:status.message,...(status.retryable?{onRetry:()=>void retryReference(key)}:{})};
 }
 return <><div ref={timeline} className="v3-card-timeline v3-chat-surface" style={chatTypographyStyle}>{entries.map(entry=>{
  const msg:ChatMessage={id:entry.id,treeNodeId:entry.id,treeNodeType:"card",role:entry.role,content:""};
  const labelKey=timelineLabels[entry.kind];
  const header=<div className="v3-card-bubble-kind"><strong>{t(`cards.${labelKey}`,{defaultValue:dictionaries.ko.cards[labelKey]})}</strong>{entry.spoken?<span>{t("cards.fromChat")}</span>:null}{entry.withdrawn?<span>{t("cards.withdrawn")}</span>:null}{entry.revised?<span>{t("cards.revised")}</span>:null}<time dateTime={entry.shownAt??entry.at}>{formatTime(entry.shownAt??entry.at,i18n.language)}</time></div>;
  const bubbleProps:HTMLAttributes<HTMLDivElement>|undefined=entry.collapsible?{
   role:"button",tabIndex:0,className:"outline-none focus-visible:ring-2 focus-visible:ring-ring","aria-expanded":expanded.has(entry.id),
   onClick:event=>{if(!(event.target as Element).closest("a,button,input,iframe"))toggle(entry.id);},
   onKeyDown:event=>{if(event.currentTarget===event.target&&(event.key==="Enter"||event.key===" ")){event.preventDefault();toggle(entry.id);}},
  }:undefined;
  return <div key={entry.id} data-card-entry={dictionaries.ko.cards[labelKey]} data-card-role={entry.role}>
   {entry.role==="user"?<UserMessage msg={msg} header={header} portraitUrl={userPortraitUrl} bubbleProps={bubbleProps}>{entry.body}</UserMessage>:<AssistantMessage msg={msg} header={header} portraitUrl={portraitUrl} bubbleProps={bubbleProps}>{entry.body}</AssistantMessage>}
  </div>;
 })}</div><CardImageViewer image={image} attachments={imageAttachments} attachmentStatus={viewerStatuses} returnFocus={imageTrigger.current} onClose={closeImage}/></>;
}

function RequestPreview({markdown,attachments,expanded,linkComponent,onImageClick,onOpenAttachment}:{markdown:string;attachments:readonly CardAttachmentReference[];expanded:boolean;linkComponent:MarkdownSourceLink;onImageClick(src:string,alt:string,trigger?:HTMLElement):void;onOpenAttachment(reference:CardAttachmentReference,trigger:HTMLElement):void}) {
 const {t}=useTranslation();
 return <><div className={expanded?undefined:"v3-card-three-lines"}><MarkdownContent content={markdown} onImageClick={onImageClick} sourceLinkComponent={linkComponent}/></div>{attachments.length?<div className="v3-card-report-thumbnails">{attachments.map(reference=>{
  const item=reference.item!;
  const src=item.previewUrl??item.originalUrl;
  if(!src)return null;
  return item.previewKind==="image"?<MarkdownImage key={item.key} src={src} alt={reference.label} onOpen={(_src,_alt,trigger)=>onOpenAttachment(reference,trigger)}/>:<a key={item.key} href={item.originalUrl??src} target="_blank" rel="noreferrer" title={reference.label} onClick={event=>{event.preventDefault();onOpenAttachment(reference,event.currentTarget);}}>{reference.label}</a>;
 })}</div>:null}<span className="v3-card-collapse-hint">{expanded?t("cards.collapse"):t("cards.showMore")}</span></>;
}

function ReportPreview({report,markdownBody,expanded,references,linkComponent,onImageClick}:{report:CardReport;markdownBody:string;expanded:boolean;references:readonly CardAttachmentReference[];linkComponent:MarkdownSourceLink;onImageClick(src:string,alt:string,trigger?:HTMLElement):void}) {
 const {t}=useTranslation();
 const images=report.format==="markdown"?[...markdownBody.matchAll(/!\[([^\]]*)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)].slice(0,2).map(match=>({alt:match[1],src:match[2]})):[];
 const summary=report.format==="html"?report.body.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,"").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,"").replace(/<[^>]+>/g," ").trim():markdownBody.replace(/!\[[^\]]*\]\([^)]*\)/g,"");
 return <div data-report-id={report.id}><strong className="v3-card-report-title">{report.title}</strong>
  {expanded?(report.format==="html"?<CustomViewIframe html={report.body} title={report.title} className="v3-card-report-html"/>:<MarkdownContent content={markdownBody} codeBlockLayout="document" onImageClick={onImageClick} sourceLinkComponent={linkComponent}/>):<><div className="v3-card-three-lines"><MarkdownContent content={summary} sourceLinkComponent={linkComponent}/></div>
   {images.length?<div className="v3-card-report-thumbnails">{images.map((img,i)=><MarkdownImage key={i} src={img.src} alt={img.alt} onOpen={onImageClick}/>)}</div>:null}</>}
  <span className="v3-card-collapse-hint">{expanded?t("cards.collapse"):t("cards.viewDetails")}</span>
 </div>;
}

function sourceLinkComponent(cardId:string,origin:string,references:readonly CardAttachmentReference[],onOpen:(reference:CardAttachmentReference,references:readonly CardAttachmentReference[],trigger?:HTMLElement)=>Promise<void>,internalLinkClick:(event:React.MouseEvent<HTMLAnchorElement>)=>void,t:ReturnType<typeof useTranslation>["t"],onUserBubble=false):MarkdownSourceLink {
 const SourceLink:MarkdownSourceLink=({href,children,onClick,node,...props})=>{
  const candidate=href?referenceFromUrl(href,cardId,origin,String(children??t("cards.attachment")),"link",[],t):null;
  const reference=candidate?(references.find(item=>item.kind==="link"&&item.key.startsWith(`${candidate.key}:markdown:`)&&item.position===node?.position?.start.offset)??referenceFromUrl(href!,cardId,origin,String(children??t("cards.attachment")),"link",references,t)):null;
  return <a className={onUserBubble?"text-white underline decoration-white/70 underline-offset-2 hover:decoration-white":"text-accent-blue hover:underline"} target="_blank" rel="noopener noreferrer" {...props} href={href}
   onClick={event=>{onClick?.(event);if(reference){event.preventDefault();void onOpen(reference,ensureReference(references,reference),event.currentTarget);}else internalLinkClick(event);}}>{children}</a>;
 };
 return SourceLink;
}

function markdownAttachmentReferences(markdown:string,cardId:string,origin:string,t:ReturnType<typeof useTranslation>["t"]):CardAttachmentReference[] {
 const visibleMarkdown=removeCode(markdown);
 const references:CardAttachmentReference[]=[];
 const definitions=new Map([...visibleMarkdown.matchAll(/^[ \t]{0,3}\[([^\]\n]+)\]:[ \t]*(?:<([^>]+)>|(\S+))/gm)].map(match=>[normalizeReferenceLabel(match[1]!),match[2]??match[3]!]));
 const pattern=/(!?)\[([^\]\n]*)\](?:\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)|\[([^\]\n]*)\])?/g;
 for(const match of visibleMarkdown.matchAll(pattern)){
  if(visibleMarkdown[match.index!+match[0].length]===":")continue;
  const target=match[3]??definitions.get(normalizeReferenceLabel(match[4]||match[2]!));
  if(!target)continue;
  const url=target.startsWith("<")?target.slice(1,-1):target;
  const reference=referenceFromUrl(url,cardId,origin,match[2]||t("cards.attachment"),match[1]?"image":"link",[],t);
  if(reference)references.push({...occurrenceReference(reference,`markdown:${match.index}`),position:match.index});
 }
 return references;
}

function normalizeReferenceLabel(label:string):string {return label.trim().replace(/\s+/g," ").toLowerCase();}
function occurrenceReference(reference:CardAttachmentReference,suffix:string):CardAttachmentReference {
 const key=`${reference.key}:${suffix}`;
 return {...reference,key,...(reference.item?{item:{...reference.item,key}}:{})};
}

function referenceFromUrl(url:string,cardId:string,origin:string,label:string,kind:CardAttachmentReference["kind"],references:readonly CardAttachmentReference[],t:ReturnType<typeof useTranslation>["t"]):CardAttachmentReference|null {
 const selection=cardAttachmentSelectionFromUrl(url,cardId,origin);
 if(selection)return referenceForSelection(selection,url,label,kind,references);
 const legacy=cardLegacyAttachmentSelectionFromUrl(url,cardId,origin);
 return legacy?legacyAttachmentReferenceFromSelection(legacy,label,kind,references,t):null;
}

function contextualizeMarkdownAttachmentUrls(markdown:string,cardId:string,origin:string):string {
 let fence:string|null=null;
 return markdown.split("\n").map(line=>{
  const marker=/^\s*(`{3,}|~{3,})/.exec(line)?.[1];
  if(fence!==null){if(marker?.[0]===fence)fence=null;return line;}
  if(marker){fence=marker[0]!;return line;}
  const definition=/^([ \t]{0,3}\[[^\]\n]+\]:[ \t]*)(<[^>]+>|\S+)/.exec(line);
  if(definition){const target=definition[2]!;const wrapped=target.startsWith("<");const url=wrapped?target.slice(1,-1):target;return line.replace(definition[0],`${definition[1]}${wrapped?"<":""}${contextualizeAttachmentUrl(url,cardId,origin)}${wrapped?">":""}`);}
  return replaceMarkdownLinksOutsideInlineCode(line,url=>contextualizeAttachmentUrl(url,cardId,origin));
 }).join("\n");
}

function replaceMarkdownLinksOutsideInlineCode(line:string,transform:(url:string)=>string):string {
 const code=/(`+)[^`\n]*?\1/g;
 const link=/(!?)\[([^\]]*)\]\((<[^>]+>|[^\s)]+)(\s+"[^"]*")?\)/g;
 let output="";
 let cursor=0;
 for(const match of line.matchAll(code)){
  const start=match.index??0;
  output+=replaceMarkdownLinks(line.slice(cursor,start),link,transform)+match[0];
  cursor=start+match[0].length;
 }
 return output+replaceMarkdownLinks(line.slice(cursor),link,transform);
}

function replaceMarkdownLinks(text:string,pattern:RegExp,transform:(url:string)=>string):string {
 return text.replace(pattern,(whole,image,label,wrappedUrl,title)=>{
  const wrapped=wrappedUrl.startsWith("<");
  const url=wrapped?wrappedUrl.slice(1,-1):wrappedUrl;
  const next=transform(url);
  if(next===url)return whole;
  return `${image}[${label}](${wrapped?`<${next}>`:next}${title??""})`;
 });
}

function contextualizeAttachmentUrl(url:string,cardId:string,origin:string):string {
 if(attachmentUrlHasContext(url,origin))return url;
 const selection=cardAttachmentSelectionFromUrl(url,cardId,origin);
 if(selection)return attachmentContentUrl(selection.attachmentId,selection.context,hasDownloadFlag(url,origin));
 const legacy=cardLegacyAttachmentSelectionFromUrl(url,cardId,origin);
 return legacy?contextualLegacyUrl(legacy.nodeId,legacy.path,legacy.context,hasDownloadFlag(url,origin)):url;
}

function hasDownloadFlag(url:string,origin:string):boolean {
 try{return new URL(url,origin).searchParams.get("download")==="true";}catch{return false;}
}

function removeCode(markdown:string):string {
 let fence:string|null=null;
 const mask=(line:string)=>line.replace(/[^\n]/g," ");
 const lines=markdown.split("\n").map(line=>{
  const marker=/^\s*(`{3,}|~{3,})/.exec(line)?.[1];
  if(fence===null){if(marker){fence=marker[0]!;return mask(line);}return line;}
  if(marker?.[0]===fence)fence=null;
  return mask(line);
 });
 return lines.join("\n").replace(/(`+)[^`\n]*?\1/g,mask);
}

function legacyAttachmentReference(cardId:string,attachment:CardRow["attachments"][number],t:ReturnType<typeof useTranslation>["t"]):CardAttachmentReference {
 return legacyAttachmentReferenceFromSelection({nodeId:attachment.nodeId,path:attachment.path,context:{type:"card",id:cardId}},attachment.name,"link",[],t,attachment.mimeType);
}

function legacyAttachmentReferenceFromSelection(selection:CardLegacyAttachmentSelection,label:string,kind:CardAttachmentReference["kind"],references:readonly CardAttachmentReference[],t:ReturnType<typeof useTranslation>["t"],mimeType?:string|null):CardAttachmentReference {
 const key=legacyReferenceKey(selection);
 const existing=references.find(reference=>(reference.key===key||reference.key.startsWith(`${key}:`))&&reference.label===label);
 if(existing)return existing;
 const name=legacyPathName(selection.path,t);
 const previewKind=legacyPreviewKind(mimeType,selection.path);
 const previewUrl=contextualLegacyUrl(selection.nodeId,selection.path,selection.context);
 const item:ChatAttachmentItem={
  key,name,mimeType:mimeType??null,byteSize:null,previewKind,availability:"ready",
  previewUrl:previewKind==="info"?null:previewUrl,originalUrl:contextualLegacyUrl(selection.nodeId,selection.path,selection.context,true),legacySources:[],
  source:{kind:"legacy",nodeId:selection.nodeId,path:selection.path,context:selection.context},
 };
 return {key:item.key,url:previewUrl,label,kind:previewKind==="image"?"image":kind,context:selection.context,item};
}

function legacyReferenceKey(selection:CardLegacyAttachmentSelection):string {
 return `legacy:${JSON.stringify([selection.nodeId,selection.path,selection.context])}`;
}

function legacyPathName(path:string,t:ReturnType<typeof useTranslation>["t"]):string {
 const name=path.split("/").filter(Boolean).at(-1)??t("cards.attachment");
 try{return decodeURIComponent(name);}catch{return name;}
}

function legacyPreviewKind(mimeType:string|null|undefined,path?:string):ChatAttachmentItem["previewKind"] {
 const normalized=mimeType?.toLowerCase().split(";",1)[0];
 if(normalized&&isImagePreviewMimeType(normalized))return "image";
 if(normalized?.startsWith("text/")||normalized==="application/json")return "text";
 const pathMime=mimeTypeForFileName(path);
 if(pathMime&&isImagePreviewMimeType(pathMime))return "image";
 if(path&&/\.(?:txt|md|markdown|json|csv)$/i.test(path))return "text";
 return "info";
}

function referenceForSelection(selection:CardAttachmentSelection,url:string,label:string,kind:CardAttachmentReference["kind"],references:readonly CardAttachmentReference[]):CardAttachmentReference {
 const key=`asset:${JSON.stringify([selection.attachmentId,selection.context])}`;
 return references.find(reference=>(reference.key===key||reference.key.startsWith(`${key}:`))&&reference.label===label&&reference.kind===kind)
  ??{key,url,label,kind,context:selection.context,selection};
}

function ensureReference(references:readonly CardAttachmentReference[],reference:CardAttachmentReference):readonly CardAttachmentReference[] {
 return references.some(item=>item.key===reference.key)?references:[...references,reference];
}

type CardAttachmentSelection = { attachmentId: string; context: AttachmentReadContext };
type CardLegacyAttachmentSelection = { nodeId: string; path: string; context: AttachmentReadContext };
type CardAttachmentReference = {
 key: string;
 position?: number;
 url: string;
 label: string;
 kind: "image" | "link";
 context: AttachmentReadContext;
 selection?: CardAttachmentSelection;
 item?: ChatAttachmentItem;
};
async function loadCardAttachmentReference(reference:CardAttachmentReference,signal:AbortSignal,t:ReturnType<typeof useTranslation>["t"]):Promise<AttachmentLoadResult> {
 if(reference.item)return loadLegacyTextSize(reference,reference.item,signal,t);
 const selection=reference.selection;
 if(!selection)return {item:unavailableItem(placeholderReference(reference),"unavailable",reference.kind==="image"?"image":"info")};
 const result=await loadAttachmentAsset({attachmentId:selection.attachmentId,context:selection.context,key:reference.key,label:reference.label},signal,t);
 if(result.item.availability==="ready"||reference.kind!=="image")return result;
 return {...result,item:{...result.item,previewKind:"image"}};
}

async function loadLegacyTextSize(reference:CardAttachmentReference,item:ChatAttachmentItem,signal:AbortSignal,t:ReturnType<typeof useTranslation>["t"]):Promise<AttachmentLoadResult> {
 if(item.previewKind!=="text"||item.previewUrl===null||item.source.kind!=="legacy")return {item};
 let response:Response;
 try{response=await fetch(item.previewUrl,{method:"HEAD",credentials:"same-origin",signal});}
 catch(error){if(signal.aborted)throw error;return failedReference(placeholderReference(reference),undefined,reference.kind==="image"?"image":"info",t);}
 if(!response.ok)return failedReference(placeholderReference(reference),response.status,reference.kind==="image"?"image":"info",t);
 const length=Number(response.headers.get("content-length"));
 return {item:Number.isSafeInteger(length)&&length>=0?{...item,byteSize:length}:item};
}

function placeholderReference(reference:CardAttachmentReference):AttachmentPlaceholderReference {
 return {
  key:reference.key,label:reference.label,context:reference.context,
  ...(reference.selection?{attachmentId:reference.selection.attachmentId}:{}),
  ...(reference.item?{item:reference.item}:{}),
 };
}
