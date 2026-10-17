import { useChatTypography } from "@seosoyoung/soul-ui/components/chat/useChatTypography";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type HTMLAttributes, type ReactNode } from "react";
import { Button, MarkdownContent, useInternalLinkClick } from "@seosoyoung/soul-ui";
import { UserMessage } from "@seosoyoung/soul-ui/components/chat/UserMessage";
import { AssistantMessage } from "@seosoyoung/soul-ui/components/chat/AssistantMessage";
import { MarkdownImage } from "@seosoyoung/soul-ui/components/MarkdownImage";
import { CustomViewIframe } from "@seosoyoung/soul-ui/custom-view/CustomViewRenderer";
import type { ChatMessage } from "@seosoyoung/soul-ui/lib/flatten-tree";
import { attachmentContentUrl, contextualLegacyUrl, type ChatAttachmentItem } from "@seosoyoung/soul-ui/lib/chat-attachment-model";
import type { CardDetail, CardItemEvidence, CardReport, CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { cardRequestMarkdown } from "./card-request-markdown";
import { CardImageViewer } from "./CardImageViewer";
import { type AttachmentReadContext, attachmentUrlHasContext, cardAttachmentSelectionFromUrl, cardLegacyAttachmentSelectionFromUrl } from "./card-attachment-selection";

type CardAttachmentSelection = { attachmentId: string; context: AttachmentReadContext };
type CardLegacyAttachmentSelection = { nodeId: string; path: string; context: AttachmentReadContext };
type CardAttachmentReference = {
 key: string;
 url: string;
 label: string;
 kind: "image" | "link";
 context: AttachmentReadContext;
 selection?: CardAttachmentSelection;
 item?: ChatAttachmentItem;
};
type MarkdownSourceLink = NonNullable<ComponentProps<typeof MarkdownContent>["sourceLinkComponent"]>;
type AttachmentDescriptor = NonNullable<CardItemEvidence["descriptor"]>;

export function CardTimeline({card,detail,portraitUrl,userPortraitUrl,onAnswer,pending,initialImage}: {
 initialImage?:{src:string;alt:string};
 card:CardRow;detail?:CardDetail;portraitUrl:string|null;userPortraitUrl?:string|null;
 onAnswer(questionId:string,answer:string):void;pending:boolean;
}) {
 const {chatTypographyStyle}=useChatTypography();
 const internalLinkClick=useInternalLinkClick();
 const [expanded,setExpanded]=useState<ReadonlySet<string>>(()=>new Set());
 const [image,setImage]=useState<{src:string;alt:string;attachment?:ChatAttachmentItem}|null>(initialImage??null);
 const [imageAttachments,setImageAttachments]=useState<readonly ChatAttachmentItem[]>([]);
 const imageTrigger=useRef<HTMLElement|null>(null);
 const attachmentRequest=useRef<AbortController|null>(null);
 const origin=typeof window==="undefined"?"http://localhost":window.location.origin;

 const openImage=useCallback((src:string,alt:string,trigger?:HTMLElement)=>{
  attachmentRequest.current?.abort();
  imageTrigger.current=trigger??(document.activeElement instanceof HTMLElement?document.activeElement:null);
  setImage({src,alt});
  setImageAttachments([]);
 },[]);
 const openReference=useCallback(async(reference:CardAttachmentReference,references:readonly CardAttachmentReference[],trigger?:HTMLElement)=>{
  attachmentRequest.current?.abort();
  const controller=new AbortController();
  attachmentRequest.current=controller;
  imageTrigger.current=trigger??(document.activeElement instanceof HTMLElement?document.activeElement:null);
  try{
   const items=await Promise.all(references.map(item=>loadCardAttachmentReference(item,controller.signal)));
   if(controller.signal.aborted)return;
   const selected=items.find(item=>item.key===reference.key);
   if(!selected)return;
   setImageAttachments(items);
   setImage({src:selected.previewUrl??selected.originalUrl??reference.url,alt:reference.label,attachment:selected});
  }catch(error){
   if(!controller.signal.aborted)throw error;
  }
 },[]);
 const closeImage=()=>{
  attachmentRequest.current?.abort();
  attachmentRequest.current=null;
  setImage(null);
  setImageAttachments([]);
  requestAnimationFrame(()=>imageTrigger.current?.focus({preventScroll:true}));
 };
 useEffect(()=>()=>attachmentRequest.current?.abort(),[]);

 // Opening the viewer must keep the original Markdown nodes mounted for focus restoration.
 const entries=useMemo(()=>{
 const openMarkdownImage=(src:string,alt:string,references:readonly CardAttachmentReference[],trigger?:HTMLElement)=>{
  const reference=referenceFromUrl(src,card.id,origin,alt,"image",references);
  if(!reference){openImage(src,alt,trigger);return;}
  void openReference(reference,ensureReference(references,reference),trigger);
 };
 const requestMarkdown=cardRequestMarkdown(card.request);
 const renderedRequestMarkdown=contextualizeMarkdownAttachmentUrls(requestMarkdown,card.id,origin);
 const requestAttachmentReferences=(card.attachments??[]).map(attachment=>legacyAttachmentReference(card.id,attachment));
 const requestReferences=[...markdownAttachmentReferences(requestMarkdown,card.id,origin),...requestAttachmentReferences];
 const requestLink=sourceLinkComponent(card.id,origin,requestReferences,openReference,internalLinkClick);
 const entries:{id:string;at:string;kind:string;role:"user"|"assistant";spoken?:boolean;collapsible?:boolean;body:ReactNode}[]=[
  {id:"request",at:card.createdAt,kind:"지시",role:"user",collapsible:true,body:<RequestPreview markdown={renderedRequestMarkdown} attachments={requestAttachmentReferences} expanded={expanded.has("request")} linkComponent={requestLink} onImageClick={(src:string,alt:string,trigger?:HTMLElement)=>openMarkdownImage(src,alt,requestReferences,trigger)} onOpenAttachment={(reference,trigger)=>void openReference(reference,requestReferences,trigger)}/>},
  ...(detail?.questions??[]).flatMap(q=>{
   const questionReferences=markdownAttachmentReferences(q.text,card.id,origin);
   const questionMarkdown=contextualizeMarkdownAttachmentUrls(q.text,card.id,origin);
   const questionLink=sourceLinkComponent(card.id,origin,questionReferences,openReference,internalLinkClick);
   const answerReferences=q.answer?markdownAttachmentReferences(q.answer,card.id,origin):[];
   const answerMarkdown=q.answer?contextualizeMarkdownAttachmentUrls(q.answer,card.id,origin):"";
   const answerLink=sourceLinkComponent(card.id,origin,answerReferences,openReference,internalLinkClick);
   return [
    {id:`q-${q.id}`,at:q.askedAt,kind:"질문",role:"assistant" as const,body:<><MarkdownContent content={questionMarkdown} onImageClick={(src:string,alt:string,trigger?:HTMLElement)=>openMarkdownImage(src,alt,questionReferences,trigger)} sourceLinkComponent={questionLink}/>{!q.answer&&q.options?.length?<div className="v3-card-answer-options">{q.options.map(option=><Button key={option} variant="outline" disabled={pending} onClick={()=>onAnswer(q.id,option)}>{option}</Button>)}</div>:null}</>},
    ...(q.answer?[{id:`a-${q.id}`,at:q.answeredAt??q.askedAt,kind:"답",role:"user" as const,body:<MarkdownContent content={answerMarkdown} onImageClick={(src:string,alt:string,trigger?:HTMLElement)=>openMarkdownImage(src,alt,answerReferences,trigger)} sourceLinkComponent={answerLink}/>}]:[]),
   ];
  }),
  ...(detail?.reports??[]).map(report=>{
   const references=markdownAttachmentReferences(report.body,card.id,origin);
   const markdownBody=report.format==="markdown"?contextualizeMarkdownAttachmentUrls(report.body,card.id,origin):report.body;
   const linkComponent=sourceLinkComponent(card.id,origin,references,openReference,internalLinkClick);
   return {id:report.id,at:report.createdAt,kind:"보고",role:"assistant" as const,collapsible:true,body:<ReportPreview report={report} markdownBody={markdownBody} expanded={expanded.has(report.id)} references={references} linkComponent={linkComponent} onImageClick={(src:string,alt:string,trigger?:HTMLElement)=>openMarkdownImage(src,alt,references,trigger)}/>};
  }),
  ...(detail?.comments??[]).filter(comment=>comment.kind!=="note").map(comment=>{
   const target=comment.itemId===undefined||comment.itemId===null?undefined:(detail?.card.items??card.items)?.find(item=>item.id===comment.itemId);
   const references=markdownAttachmentReferences(comment.body,card.id,origin);
   const commentMarkdown=contextualizeMarkdownAttachmentUrls(comment.body,card.id,origin);
   const linkComponent=sourceLinkComponent(card.id,origin,references,openReference,internalLinkClick);
   return {id:comment.id,at:comment.createdAt,kind:"커멘트",spoken:comment.kind==="spoken",role:comment.authorKind==="agent"?"assistant" as const:"user" as const,
    body:<>{comment.itemId!==undefined&&comment.itemId!==null?<p className="v3-card-comment-target">대상: {comment.itemId}번 {target?.title??"항목"}</p>:null}<MarkdownContent content={commentMarkdown} onImageClick={(src:string,alt:string,trigger?:HTMLElement)=>openMarkdownImage(src,alt,references,trigger)} sourceLinkComponent={linkComponent}/></>};
  }),
 ];
 return entries.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
 },[card,detail,expanded,pending,onAnswer,openImage,openReference,origin,internalLinkClick]);
 const toggle=(id:string)=>setExpanded(current=>{const next=new Set(current);if(next.has(id))next.delete(id);else next.add(id);return next;});
 return <><div className="v3-card-timeline v3-chat-surface" style={chatTypographyStyle}>{entries.map(entry=>{
  const msg:ChatMessage={id:entry.id,treeNodeId:entry.id,treeNodeType:"card",role:entry.role,content:""};
  const header=<div className="v3-card-bubble-kind"><strong>{entry.kind}</strong>{entry.spoken?<span>대화에서</span>:null}<time dateTime={entry.at}>{entry.at?new Date(entry.at).toLocaleTimeString("ko-KR",{hour:"2-digit",minute:"2-digit",hourCycle:"h23"}):""}</time></div>;
  const bubbleProps:HTMLAttributes<HTMLDivElement>|undefined=entry.collapsible?{
   role:"button",tabIndex:0,className:"outline-none focus-visible:ring-2 focus-visible:ring-ring","aria-expanded":expanded.has(entry.id),
   onClick:event=>{if(!(event.target as Element).closest("a,button,input,iframe"))toggle(entry.id);},
   onKeyDown:event=>{if(event.currentTarget===event.target&&(event.key==="Enter"||event.key===" ")){event.preventDefault();toggle(entry.id);}},
  }:undefined;
  return <div key={entry.id} data-card-entry={entry.kind} data-card-role={entry.role}>
   {entry.role==="user"?<UserMessage msg={msg} header={header} portraitUrl={userPortraitUrl} bubbleProps={bubbleProps}>{entry.body}</UserMessage>:<AssistantMessage msg={msg} header={header} portraitUrl={portraitUrl} bubbleProps={bubbleProps}>{entry.body}</AssistantMessage>}
  </div>;
 })}</div><CardImageViewer image={image} attachments={imageAttachments} returnFocus={imageTrigger.current} onClose={closeImage}/></>;
}

function RequestPreview({markdown,attachments,expanded,linkComponent,onImageClick,onOpenAttachment}:{markdown:string;attachments:readonly CardAttachmentReference[];expanded:boolean;linkComponent:MarkdownSourceLink;onImageClick(src:string,alt:string,trigger?:HTMLElement):void;onOpenAttachment(reference:CardAttachmentReference,trigger:HTMLElement):void}) {
 return <><div className={expanded?undefined:"v3-card-three-lines"}><MarkdownContent content={markdown} onImageClick={onImageClick} sourceLinkComponent={linkComponent}/></div>{attachments.length?<div className="v3-card-report-thumbnails">{attachments.map(reference=>{
  const item=reference.item!;
  const src=item.previewUrl??item.originalUrl;
  if(!src)return null;
  return item.previewKind==="image"?<MarkdownImage key={item.key} src={src} alt={reference.label} onOpen={(_src,_alt,trigger)=>onOpenAttachment(reference,trigger)}/>:<a key={item.key} href={item.originalUrl??src} target="_blank" rel="noreferrer" title={reference.label} onClick={event=>{event.preventDefault();onOpenAttachment(reference,event.currentTarget);}}>{reference.label}</a>;
 })}</div>:null}<span className="v3-card-collapse-hint">{expanded?"접기":"더 보기"}</span></>;
}

function ReportPreview({report,markdownBody,expanded,references,linkComponent,onImageClick}:{report:CardReport;markdownBody:string;expanded:boolean;references:readonly CardAttachmentReference[];linkComponent:MarkdownSourceLink;onImageClick(src:string,alt:string,trigger?:HTMLElement):void}) {
 const images=report.format==="markdown"?[...markdownBody.matchAll(/!\[([^\]]*)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)].slice(0,2).map(match=>({alt:match[1],src:match[2]})):[];
 const summary=report.format==="html"?report.body.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,"").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,"").replace(/<[^>]+>/g," ").trim():markdownBody.replace(/!\[[^\]]*\]\([^)]*\)/g,"");
 return <div data-report-id={report.id}><strong className="v3-card-report-title">{report.title}</strong>
  {expanded?(report.format==="html"?<CustomViewIframe html={report.body} title={report.title} className="v3-card-report-html"/>:<MarkdownContent content={markdownBody} codeBlockLayout="document" onImageClick={onImageClick} sourceLinkComponent={linkComponent}/>):<><div className="v3-card-three-lines"><MarkdownContent content={summary} sourceLinkComponent={linkComponent}/></div>
   {images.length?<div className="v3-card-report-thumbnails">{images.map((img,i)=><MarkdownImage key={i} src={img.src} alt={img.alt} onOpen={onImageClick}/>)}</div>:null}</>}
  <span className="v3-card-collapse-hint">{expanded?"접기":"자세히"}</span>
 </div>;
}

function sourceLinkComponent(cardId:string,origin:string,references:readonly CardAttachmentReference[],onOpen:(reference:CardAttachmentReference,references:readonly CardAttachmentReference[],trigger?:HTMLElement)=>Promise<void>,internalLinkClick:(event:React.MouseEvent<HTMLAnchorElement>)=>void):MarkdownSourceLink {
 const SourceLink:MarkdownSourceLink=({href,children,onClick,...props})=>{
  const reference=href?referenceFromUrl(href,cardId,origin,String(children??"첨부"),"link",references):null;
  return <a className="text-accent-blue hover:underline" target="_blank" rel="noopener noreferrer" {...props} href={href}
   onClick={event=>{onClick?.(event);if(reference){event.preventDefault();void onOpen(reference,ensureReference(references,reference),event.currentTarget);}else internalLinkClick(event);}}>{children}</a>;
 };
 return SourceLink;
}

function markdownAttachmentReferences(markdown:string,cardId:string,origin:string):CardAttachmentReference[] {
 const visibleMarkdown=removeCode(markdown);
 const references:CardAttachmentReference[]=[];
 const seen=new Set<string>();
 const pattern=/(!?)\[([^\]]*)\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g;
 for(const match of visibleMarkdown.matchAll(pattern)){
  const url=match[3]!.startsWith("<")?match[3]!.slice(1,-1):match[3]!;
  const reference=referenceFromUrl(url,cardId,origin,match[2]||"첨부",match[1]?"image":"link",references);
  if(!reference||seen.has(reference.key))continue;
  seen.add(reference.key);
  references.push(reference);
 }
 return references;
}

function referenceFromUrl(url:string,cardId:string,origin:string,label:string,kind:CardAttachmentReference["kind"],references:readonly CardAttachmentReference[]):CardAttachmentReference|null {
 const selection=cardAttachmentSelectionFromUrl(url,cardId,origin);
 if(selection)return referenceForSelection(selection,url,label,kind,references);
 const legacy=cardLegacyAttachmentSelectionFromUrl(url,cardId,origin);
 return legacy?legacyAttachmentReferenceFromSelection(legacy,label,kind,references):null;
}

function contextualizeMarkdownAttachmentUrls(markdown:string,cardId:string,origin:string):string {
 let fence:string|null=null;
 return markdown.split("\n").map(line=>{
  const marker=/^\s*(`{3,}|~{3,})/.exec(line)?.[1];
  if(fence!==null){if(marker?.[0]===fence)fence=null;return line;}
  if(marker){fence=marker[0]!;return line;}
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
 const lines=markdown.split("\n").filter(line=>{
  const marker=/^\s*(`{3,}|~{3,})/.exec(line)?.[1];
  if(fence===null){if(marker){fence=marker[0]!;return false;}return true;}
  if(marker?.[0]===fence)fence=null;
  return false;
 });
 return lines.join("\n").replace(/(`+)[^`\n]*?\1/g,"");
}

function legacyAttachmentReference(cardId:string,attachment:CardRow["attachments"][number]):CardAttachmentReference {
 return legacyAttachmentReferenceFromSelection({nodeId:attachment.nodeId,path:attachment.path,context:{type:"card",id:cardId}},attachment.name,"link",[],attachment.mimeType);
}

function legacyAttachmentReferenceFromSelection(selection:CardLegacyAttachmentSelection,label:string,kind:CardAttachmentReference["kind"],references:readonly CardAttachmentReference[],mimeType?:string|null):CardAttachmentReference {
 const key=legacyReferenceKey(selection);
 const existing=references.find(reference=>reference.key===key);
 if(existing)return existing;
 const name=label.trim()||legacyPathName(selection.path);
 const previewKind=legacyPreviewKind(mimeType,selection.path);
 const previewUrl=contextualLegacyUrl(selection.nodeId,selection.path,selection.context);
 const item:ChatAttachmentItem={
  key,name,mimeType:mimeType??null,byteSize:null,previewKind,availability:"ready",
  previewUrl:previewKind==="info"?null:previewUrl,originalUrl:contextualLegacyUrl(selection.nodeId,selection.path,selection.context,true),legacySources:[],
  source:{kind:"legacy",nodeId:selection.nodeId,path:selection.path,context:selection.context},
 };
 return {key:item.key,url:previewUrl,label:name,kind:previewKind==="image"?"image":kind,context:selection.context,item};
}

function legacyReferenceKey(selection:CardLegacyAttachmentSelection):string {
 return `legacy:${JSON.stringify([selection.nodeId,selection.path,selection.context])}`;
}

function legacyPathName(path:string):string {
 const name=path.split("/").filter(Boolean).at(-1)??"첨부";
 try{return decodeURIComponent(name);}catch{return name;}
}

function legacyPreviewKind(mimeType:string|null|undefined,path?:string):ChatAttachmentItem["previewKind"] {
 const normalized=mimeType?.toLowerCase().split(";",1)[0];
 if(normalized==="image/svg+xml")return "info";
 if(normalized?.startsWith("image/"))return "image";
 if(normalized?.startsWith("text/")||normalized==="application/json")return "text";
 if(path&&/\.(?:png|jpe?g|gif|webp|heic|avif)$/i.test(path))return "image";
 if(path&&/\.(?:txt|md|markdown|json|csv)$/i.test(path))return "text";
 return "info";
}

function referenceForSelection(selection:CardAttachmentSelection,url:string,label:string,kind:CardAttachmentReference["kind"],references:readonly CardAttachmentReference[]):CardAttachmentReference {
 const key=`asset:${JSON.stringify([selection.attachmentId,selection.context])}`;
 return references.find(reference=>reference.key===key)
  ??{key,url,label,kind,context:selection.context,selection};
}

function ensureReference(references:readonly CardAttachmentReference[],reference:CardAttachmentReference):readonly CardAttachmentReference[] {
 return references.some(item=>item.key===reference.key)?references:[...references,reference];
}

async function loadCardAttachmentReference(reference:CardAttachmentReference,signal:AbortSignal):Promise<ChatAttachmentItem> {
 if(reference.item)return loadLegacyTextSize(reference.item,signal);
 const selection=reference.selection;
 if(!selection)return unavailableItem(reference,"unavailable");
 const metadataUrl=`/api/attachments/${encodeURIComponent(selection.attachmentId)}?${attachmentContextQuery(selection.context)}`;
 let response:Response;
 try{
  response=await fetch(metadataUrl,{credentials:"same-origin",signal});
 }catch(error){if(signal.aborted)throw error;return unavailableItem(reference,"unavailable");}
 if(!response.ok)return unavailableItem(reference,response.status===404?"missing":"unavailable");
 const body:unknown=await response.json().catch(()=>null);
 if(!isMetadataResponse(body,selection.attachmentId))return unavailableItem(reference,"unavailable");
 if(body.upload_status!=="committed")return unavailableItem(reference,"unavailable");
 const descriptor=body.descriptor;
 const context=selection.context;
 const contentUrl=attachmentContentUrl(selection.attachmentId,context);
 return {
  key:reference.key,name:descriptor.name,mimeType:descriptor.mime_type,byteSize:descriptor.byte_size,
  previewKind:descriptor.preview_kind,availability:"ready",
  previewUrl:descriptor.preview_kind==="info"?null:contentUrl,
  originalUrl:attachmentContentUrl(selection.attachmentId,context,true),legacySources:[],
  source:{kind:"asset",attachmentId:selection.attachmentId,context},
 };
}

async function loadLegacyTextSize(item:ChatAttachmentItem,signal:AbortSignal):Promise<ChatAttachmentItem> {
 if(item.previewKind!=="text"||item.previewUrl===null||item.source.kind!=="legacy")return item;
 let response:Response;
 try{response=await fetch(item.previewUrl,{method:"HEAD",credentials:"same-origin",signal});}
 catch(error){if(signal.aborted)throw error;return item;}
 if(response.status===404)return unavailableLegacyItem(item,"missing");
 if(response.status===401||response.status===403)return unavailableLegacyItem(item,"unavailable");
 if(!response.ok)return item;
 const length=Number(response.headers.get("content-length"));
 return Number.isSafeInteger(length)&&length>=0?{...item,byteSize:length}:item;
}

function unavailableLegacyItem(item:ChatAttachmentItem,availability:"missing"|"unavailable"):ChatAttachmentItem {
 if(item.source.kind!=="legacy")return item;
 return {...item,availability,previewUrl:null,originalUrl:null,source:{kind:"unavailable",path:item.source.path,context:item.source.context}};
}

function unavailableItem(reference:CardAttachmentReference,availability:"missing"|"unavailable"):ChatAttachmentItem {
 const attachmentId=reference.selection?.attachmentId;
 return {
  key:reference.key,name:reference.label||null,mimeType:null,byteSize:null,previewKind:reference.kind==="image"?"image":"info",
  availability,previewUrl:null,originalUrl:null,legacySources:[],
  source:{kind:"unavailable",...(attachmentId?{attachmentId}:{}),context:reference.context},
 };
}

function attachmentContextQuery(context:AttachmentReadContext):string {
 const params=new URLSearchParams({context_type:context.type});
 if(context.type!=="owner")params.set("context_id",context.id);
 return params.toString();
}

function isMetadataResponse(value:unknown,attachmentId:string):value is {descriptor:AttachmentDescriptor;upload_status:"pending"|"committed"} {
 if(typeof value!=="object"||value===null||!("descriptor" in value)||!("upload_status" in value))return false;
 const descriptor=value.descriptor;
 return typeof descriptor==="object"&&descriptor!==null
  &&"attachment_id" in descriptor&&descriptor.attachment_id===attachmentId
  &&"name" in descriptor&&typeof descriptor.name==="string"
  &&"mime_type" in descriptor&&typeof descriptor.mime_type==="string"
  &&"byte_size" in descriptor&&typeof descriptor.byte_size==="number"
  &&"preview_kind" in descriptor&&(descriptor.preview_kind==="image"||descriptor.preview_kind==="text"||descriptor.preview_kind==="info")
  &&(value.upload_status==="pending"||value.upload_status==="committed");
}
