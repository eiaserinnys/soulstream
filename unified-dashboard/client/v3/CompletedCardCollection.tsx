import type { ReactNode } from "react";
import type { CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { PostItGrid,type PostItVariant } from "./PostItCard";
import { CompletedCardGrid } from "./CompletedCardGrid";
import type { CompletedBrowser } from "./use-completed-cards";
import "./v3-card-board.css";
export function CompletedCardCollection({browser,renderCard,variant="default"}:{browser:CompletedBrowser;renderCard(card:CardRow):ReactNode;variant?:PostItVariant}) {
  return <PostItGrid className="v3-completed-collection" variant={variant}>
    <div className="v3-detail-section-head"><h3>완료</h3><span>{browser.cards.length}개 표시</span></div>
    <CompletedCardGrid browser={browser} renderCard={renderCard}/>
  </PostItGrid>;
}
