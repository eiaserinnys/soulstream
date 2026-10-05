import { Checkbox } from "@seosoyoung/soul-ui";
import type { CardCheckItem } from "@seosoyoung/soul-ui/cards/card-types";
import { MarkdownImage } from "@seosoyoung/soul-ui/components/MarkdownImage";
import { Circle } from "lucide-react";
import "./v3-card-check-items.css";

const displayLabels:Record<CardCheckItem["display"],string>={
  todo:"아직",doing:"하는 중",reported:"됐다고 보고",changed:"다시 봐 주세요",fix:"고칠 점",confirmed:"확인함",dropped:"뺌",
};

export function CardCheckItemRow({item,checked,pending,expanded,onConfirmChange,onToggleExpanded,onTargetItem,onOpenImage}: {
 item:CardCheckItem;checked:boolean;pending:boolean;expanded:boolean;
 onConfirmChange(confirmed:boolean):void;onToggleExpanded():void;onTargetItem():void;onOpenImage(src:string,alt:string):void;
}) {
 const dropped=item.display==="dropped";
 const display=checked&&pending?"confirmed":item.display;
 const showBody=expanded||dropped;
 const images=item.evidence.filter(evidence=>evidence.type==="image");
 const links=item.evidence.filter(evidence=>evidence.type==="link");
 const metadata=<div className="v3-card-check-item-meta">
  <span>{item.reportedAt?"보고":"추가"} · {formatTime(item.reportedAt??item.createdAt)}</span>
  {item.from?<span>{item.from.kind==="spoken"?"대화에서 추가":"커멘트에서 추가"}</span>:null}
 </div>;
 return <div className={`v3-card-check-item-shell${display==="doing"?" card-running-base":""}`}>
  <article className={`v3-card-check-item-row${display==="doing"?" card-running":""}`} data-item-id={item.id} data-item-display={display}>
   <div className="v3-card-check-item-heading">
    <Checkbox variant="card-item" aria-label={`${item.id}번 확인`} checked={checked} disabled={dropped||pending}
     onCheckedChange={value=>onConfirmChange(Boolean(value))}/>
    <button type="button" className="v3-card-check-item-title-button" aria-expanded={showBody} aria-label={`${item.id}번 항목 ${showBody?"접기":"펼치기"}`}
     disabled={dropped} onClick={onToggleExpanded}>
     <span className="v3-card-check-item-number">{item.id}.</span>
     <span className="v3-card-check-item-title">{dropped?<del>{item.title}</del>:item.title}</span>
     <span className={`v3-card-check-item-state v3-card-check-item-state--${display}`}>
      {display==="doing"?<Circle className="v3-card-check-item-state-dot" aria-hidden="true"/>:null}
      <span>{displayLabels[display]}{display==="fix"?` ${item.fixOpen}`:""}</span>
     </span>
    </button>
   </div>
   {showBody?<div className="v3-card-check-item-body">
    {display==="changed"&&item.reopened?<p className="v3-card-check-item-reopened">{item.reopened}</p>:null}
    {item.result?<p className="v3-card-check-item-result">{item.result}</p>:null}
    <div className="v3-card-check-item-evidence" data-evidence-type="image">
     {images.map((evidence,index)=><figure key={`${evidence.url}:${index}`}>
      <MarkdownImage variant="card-evidence" src={evidence.url} alt={evidence.label} onOpen={onOpenImage}/>
      <figcaption>{evidence.label}</figcaption>
     </figure>)}
     {images.length===0?<span className="v3-card-check-item-no-image">캡처 없음</span>:null}
    </div>
    {links.length?<div className="v3-card-check-item-links" data-evidence-type="link">{links.map((evidence,index)=><a key={`${evidence.url}:${index}`} href={evidence.url} target="_blank" rel="noreferrer" title={evidence.label}>{evidence.label}</a>)}</div>:null}
    <div className="v3-card-check-item-foot">
     {item.caveat?<p className="v3-card-check-item-caveat" title={`${item.reportedAt?"보고":"추가"} · ${formatTime(item.reportedAt??item.createdAt)}`}>{item.caveat}</p>:metadata}
     {!dropped?<button type="button" className="v3-card-check-item-target" onClick={onTargetItem}>고칠 점 남기기</button>:null}
    </div>
   </div>:null}
  </article>
 </div>;
}

function formatTime(value:string) {
 const date=new Date(value);
 return Number.isNaN(date.getTime())?"":date.toLocaleTimeString("ko-KR",{hour:"2-digit",minute:"2-digit"});
}
