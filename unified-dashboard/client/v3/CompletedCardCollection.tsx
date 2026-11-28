import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";
import type { CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { PostItGrid,type PostItVariant } from "./PostItCard";
import { CompletedCardGrid } from "./CompletedCardGrid";
import type { CompletedBrowser } from "./use-completed-cards";
import "./v3-card-board.css";
export function CompletedCardCollection({browser,renderCard,variant="default",heading="detail"}:{browser:CompletedBrowser;renderCard(card:CardRow):ReactNode;variant?:PostItVariant;heading?:"detail"|"section"}) {
 const {t}=useTranslation();
  return <PostItGrid className="v3-completed-collection" variant={variant}>
    {heading==="section"?<div className="v3-section-head"><h2>{t("cards.status.done")}</h2>{browser.loaded?<span>{t("cards.shownCount",{count:browser.cards.length})}</span>:null}</div>
      :<div className="v3-detail-section-head"><h3>{t("cards.status.done")}</h3>{browser.loaded?<span>{t("cards.shownCount",{count:browser.cards.length})}</span>:null}</div>}
    <CompletedCardGrid browser={browser} renderCard={renderCard}/>
  </PostItGrid>;
}
