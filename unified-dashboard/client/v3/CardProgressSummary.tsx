import { useTranslation } from "react-i18next";
import type { CardItemSummary } from "./card-item-summary";
import "./v3-card-check-items.css";

export function CardProgressSummary({summary,showReviewCount=false}: {summary:CardItemSummary;showReviewCount?:boolean}) {
 const {t}=useTranslation();
 const count=[showReviewCount&&summary.toReviewCount>0?t("cards.toReviewCount", {count:summary.toReviewCount}):null,summary.confirmedCount>0?t("cards.confirmedCount", {count:summary.confirmedCount}):null].filter(Boolean).join(", ");
 return <span className="v3-card-progress" aria-label={[t("cards.unconfirmedCount", {count:summary.activeCount}),count].filter(Boolean).join(", ")}>
  <span className="v3-card-progress-dots" aria-hidden="true">{summary.activeItems.map(item=><i key={item.id} className={`v3-card-progress-dot v3-card-progress-dot--${item.display}`}/>)}</span>
  {count?<span className="v3-card-progress-count">{count}</span>:null}
 </span>;
}
