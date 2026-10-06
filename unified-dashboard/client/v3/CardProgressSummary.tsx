import type { CardItemSummary } from "./card-item-summary";
import "./v3-card-check-items.css";

export function CardProgressSummary({summary,showReviewCount=false}: {summary:CardItemSummary;showReviewCount?:boolean}) {
 const count=[showReviewCount&&summary.toReviewCount>0?`볼 것 ${summary.toReviewCount}`:null,summary.confirmedCount>0?`확인 ${summary.confirmedCount}`:null].filter(Boolean).join(", ");
 return <span className="v3-card-progress" aria-label={[`미확인 항목 ${summary.activeCount}개`,count].filter(Boolean).join(", ")}>
  <span className="v3-card-progress-dots" aria-hidden="true">{summary.activeItems.map(item=><i key={item.id} className={`v3-card-progress-dot v3-card-progress-dot--${item.display}`}/>)}</span>
  {count?<span className="v3-card-progress-count">{count}</span>:null}
 </span>;
}
