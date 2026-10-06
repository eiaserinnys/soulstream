import { Checkbox } from "@seosoyoung/soul-ui";
import type { CardCheckItem } from "@seosoyoung/soul-ui/cards/card-types";
import { MarkdownImage } from "@seosoyoung/soul-ui/components/MarkdownImage";
import { Link, TriangleAlert } from "lucide-react";
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
 const label=`${item.id} ${item.title}, ${displayLabels[display]}${display==="fix"?` ${item.fixOpen}`:""}`;
 const showBody=expanded||dropped;
 const images=item.evidence.filter(evidence=>evidence.type==="image");
 const links=item.evidence.filter(evidence=>evidence.type==="link");
 const when=[item.reportedAt?formatTime(item.reportedAt):null,
  item.from?`${formatTime(item.createdAt)} ${item.from.kind==="spoken"?"대화에서 추가":"커멘트에서 추가"}`:item.reportedAt?null:formatTime(item.createdAt)].filter(Boolean).join(", ");
 const metadata=<span className="v3-card-check-item-meta">{when}</span>;
 return <div className={`v3-card-check-item-shell${display==="doing"?" card-running-base":""}`}>
  <article className={`v3-card-check-item-row${display==="doing"?" card-running":""}`} data-item-id={item.id} data-item-display={display}>
   <div className="v3-card-check-item-heading">
    <Checkbox variant="card-item" aria-label={label} checked={checked} disabled={dropped||pending}
     onCheckedChange={value=>onConfirmChange(Boolean(value))}/>
    <button type="button" className="v3-card-check-item-title-button" aria-expanded={showBody} aria-label={`${item.id}번 항목 ${showBody?"접기":"펼치기"}`}
     disabled={dropped} onClick={onToggleExpanded}>
     <span className="v3-card-check-item-number">{item.id}</span>
     <span className="v3-card-check-item-title">{dropped?<del>{item.title}</del>:item.title}</span>
    </button>
   </div>
   {showBody?<div className="v3-card-check-item-body">
    {display==="changed"&&item.reopened?<p className="v3-card-check-item-reopened"><strong>확인한 뒤 바뀜</strong><span>{item.reopened}</span></p>:null}
    {item.result?<p className="v3-card-check-item-result">{item.result}</p>:null}
    {item.caveat?<p className="v3-card-check-item-caveat"><TriangleAlert className="h-3 w-3" aria-hidden="true"/><span>{item.caveat}</span></p>:null}
    <div className="v3-card-check-item-evidence" data-evidence-type="image">
     {images.map((evidence,index)=><figure key={`${evidence.url}:${index}`} title={evidence.label}>
      <MarkdownImage variant="card-evidence" src={evidence.url} alt={evidence.label} onOpen={onOpenImage}/>
     </figure>)}
     {images.length===0&&(display==="reported"||display==="changed")?<span className="v3-card-check-item-no-image">캡처 없음</span>:null}
    </div>
    {links.length?<div className="v3-card-check-item-links" data-evidence-type="link">{links.map((evidence,index)=><a key={`${evidence.url}:${index}`} href={evidence.url} target="_blank" rel="noreferrer" title={evidence.label}><Link className="h-3 w-3" aria-hidden="true"/>{evidence.label}</a>)}</div>:null}
    <div className="v3-card-check-item-foot">
     {metadata}
     {!dropped?<button type="button" className="v3-card-check-item-target" onClick={onTargetItem}>고칠 점 남기기</button>:null}
    </div>
   </div>:null}
  </article>
 </div>;
}

function formatTime(value:string) {
 const date=new Date(value);
 return Number.isNaN(date.getTime())?"":date.toLocaleTimeString("ko-KR",{hour:"2-digit",minute:"2-digit",hourCycle:"h23"});
}
