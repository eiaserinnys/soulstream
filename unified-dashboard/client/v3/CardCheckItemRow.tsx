import { useTranslation } from "react-i18next";
import { useState } from "react";
import { Checkbox, useInternalLinkClick } from "@seosoyoung/soul-ui";
import { isPlainLeftClick } from "@seosoyoung/soul-ui/components/InternalLinkProvider";
import type { CardCheckItem } from "@seosoyoung/soul-ui/cards/card-types";
import type { ChatAttachmentItem } from "@seosoyoung/soul-ui/lib/chat-attachment-model";
import { MarkdownImage } from "@seosoyoung/soul-ui/components/MarkdownImage";
import { Check, Link, TriangleAlert } from "lucide-react";
import { cardAttachmentSelectionFromEvidence } from "./card-attachment-selection";
import "./v3-card-check-items.css";

export function CardCheckItemRow({item,checked,pending,expanded,onConfirmChange,onToggleExpanded,onTargetItem,onOpenImage,readOnly=false}: {
 item:CardCheckItem;checked:boolean;pending:boolean;expanded:boolean;
 onConfirmChange(confirmed:boolean):void;onToggleExpanded():void;onTargetItem():void;onOpenImage(src:string,alt:string,attachment?:ChatAttachmentItem):void;
 readOnly?:boolean;
}) {
 const {t,i18n}=useTranslation();
 const internalLinkClick=useInternalLinkClick();
 // An image whose bytes fail to load shows the same short failure text as a
 // missing file instead of the browser's broken-image box.
 const [failedImages,setFailedImages]=useState<ReadonlySet<string>>(()=>new Set());
 const markImageFailed=(src:string)=>setFailedImages(current=>current.has(src)?current:new Set(current).add(src));
 const dropped=item.display==="dropped";
 const display=checked&&pending?"confirmed":item.display;
 const label=`${item.id} ${item.title}, ${t(`cards.itemStatus.${display}`,{defaultValue:display})}${display==="fix"?` ${item.fixOpen}`:""}`;
 const showBody=readOnly||expanded||dropped;
 const images=item.evidence.filter(evidence=>evidence.type==="image");
 const links=item.evidence.filter(evidence=>evidence.type==="link");
 // Failed evidence of one kind collapses into a single failure text at the row end,
 // the way "캡처 없음" sits, instead of repeating it next to every attachment.
 const imageFailureCount=images.filter(evidence=>{
  const src=evidence.previewUrl??evidence.url;
  return Boolean(evidence.availability)||(Boolean(src)&&failedImages.has(src));
 }).length;
 const linkFailureCount=links.filter(evidence=>Boolean(evidence.availability)).length;
 const missingEvidence=item.evidence.length===0&&(display==="reported"||display==="changed");
 const when=[item.reportedAt?formatTime(item.reportedAt,i18n.language):null,
  item.from?`${formatTime(item.createdAt,i18n.language)} ${item.from.kind==="spoken"?t("cards.addedFromChat"):t("cards.addedFromComment")}`:item.reportedAt?null:formatTime(item.createdAt,i18n.language)].filter(Boolean).join(", ");
 const metadata=<span className="v3-card-check-item-meta">{when}</span>;
 return <div className={`v3-card-check-item-shell${display==="doing"?" card-running-base":""}`}>
  <article className={`v3-card-check-item-row${display==="doing"?" card-running":""}`} data-item-id={item.id} data-item-display={display}>
   <div className="v3-card-check-item-heading">
    {readOnly?<span className="v3-card-check-item-readonly-status" data-checked={checked||undefined} role="img" aria-label={label}>{checked?<Check className="h-4 w-4" aria-hidden="true"/>:null}</span>
     :<Checkbox variant="card-item" aria-label={label} checked={checked} disabled={dropped||pending}
      onCheckedChange={value=>onConfirmChange(Boolean(value))}/>}
    {readOnly?<span className="v3-card-check-item-readonly-title">
     <span className="v3-card-check-item-number">{item.id}</span>
     <span className="v3-card-check-item-title">{dropped?<del>{item.title}</del>:item.title}</span>
    </span>:<button type="button" className="v3-card-check-item-title-button" aria-expanded={showBody} aria-label={t("cards.toggleItem", {number:item.id,action:showBody?t("cards.collapse"):t("cards.expand")})}
     disabled={dropped} onClick={onToggleExpanded}>
     <span className="v3-card-check-item-number">{item.id}</span>
     <span className="v3-card-check-item-title">{dropped?<del>{item.title}</del>:item.title}</span>
    </button>}
   </div>
   {showBody?<div className="v3-card-check-item-body">
    {display==="changed"&&item.reopened?<p className="v3-card-check-item-reopened"><strong>{t("cards.changedAfterConfirmation")}</strong><span>{item.reopened}</span></p>:null}
    {item.result?<p className="v3-card-check-item-result">{item.result}</p>:null}
    {item.caveat?<p className="v3-card-check-item-caveat"><TriangleAlert className="h-3 w-3" aria-hidden="true"/><span>{item.caveat}</span></p>:null}
    {images.length>0||missingEvidence?<div className="v3-card-check-item-evidence" data-evidence-type="image">
     {images.map((evidence,index)=>{
      const key=evidence.attachment_id?`${evidence.attachment_id}:${index}`:`${evidence.url}:${index}`;
      const src=evidence.previewUrl??evidence.url;
      if(evidence.availability||!src||failedImages.has(src))return null;
      return <figure key={key} title={evidence.label}>
       <MarkdownImage variant="card-evidence" src={src} alt={evidence.label} onOpen={(imageSrc,alt)=>onOpenImage(imageSrc,alt,cardAttachmentSelectionFromEvidence(evidence)??undefined)} onError={markImageFailed}/>
      </figure>;
     })}
     {imageFailureCount>0?<span className="v3-card-check-item-no-image">{t("cards.fileLoadError")}</span>:null}
     {missingEvidence?<span className="v3-card-check-item-no-image">{t("cards.noScreenshot")}</span>:null}
    </div>:null}
    {links.length?<div className="v3-card-check-item-links" data-evidence-type="link">{links.map((evidence,index)=>{
     const key=evidence.attachment_id?`${evidence.attachment_id}:${index}`:`${evidence.url}:${index}`;
     if(evidence.availability)return null;
     const attachment=cardAttachmentSelectionFromEvidence(evidence);
     return <a key={key} href={evidence.originalUrl??evidence.url} target="_blank" rel="noreferrer" title={evidence.label}
      onClick={event=>{if(!isPlainLeftClick(event))return;if(attachment){event.preventDefault();onOpenImage(attachment.previewUrl??attachment.originalUrl??evidence.url,evidence.label,attachment);}else internalLinkClick(event);}}>
      <Link className="h-3 w-3" aria-hidden="true"/>{evidence.label}</a>;
    })}{linkFailureCount>0?<span className="v3-card-check-item-no-image">{t("cards.fileLoadError")}</span>:null}</div>:null}
    {!readOnly?<div className="v3-card-check-item-foot">
     {metadata}
     {!dropped?<button type="button" className="v3-card-check-item-target" onClick={onTargetItem}>{t("cards.requestFix")}</button>:null}
    </div>:null}
   </div>:null}
  </article>
 </div>;
}

export function formatTime(value:string,locale:string) {
 const date=new Date(value);
 return Number.isNaN(date.getTime())?"":date.toLocaleTimeString(locale,{hour:"2-digit",minute:"2-digit",...(locale==="ko"?{hourCycle:"h23"}:{})});
}
