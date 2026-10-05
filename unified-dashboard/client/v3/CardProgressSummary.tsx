import type { CardItemSummary } from "./card-item-summary";
import "./v3-card-check-items.css";

export function CardProgressSummary({summary,showReviewCount=false}: {summary:CardItemSummary;showReviewCount?:boolean}) {
 return <span className="v3-card-progress" aria-label={`미확인 항목 ${summary.activeCount}개, 확인 ${summary.confirmedCount}개`}>
  <span className="v3-card-progress-dots" aria-hidden="true">{summary.activeItems.map(item=><i key={item.id} className={`v3-card-progress-dot v3-card-progress-dot--${item.display}`}/>)}</span>
  <span className="v3-card-progress-count">{showReviewCount?`볼 것 ${summary.toReviewCount}, `:""}확인 {summary.confirmedCount}</span>
 </span>;
}
