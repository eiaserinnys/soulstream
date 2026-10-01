import type { ReactNode } from "react";
import { Button } from "@seosoyoung/soul-ui";
import type { CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { PostItGrid } from "./PostItCard";
import type { CardCompletionOption } from "./CardCompletionFilter";
import "./v3-card-board.css";

export const boardColumns = [
  {status:"todo",label:"드래프트"}, {status:"queued",label:"대기"},
  {status:"running",label:"실행 중"}, {status:"blocked",label:"막힘"},
  {status:"review",label:"검수 대기"}, {status:"done",label:"완료"},
] as const;

/** Six fixed lanes. Card rendering and mutations remain with the existing card. */
export function CardBoard({cards, renderCard, completion}: {
  cards: readonly CardRow[]; renderCard(card:CardRow):ReactNode; completion?:CardCompletionOption;
}) {
  const visible=cards.filter(card=>!card.archived && card.status!=="cancelled");
  return <PostItGrid className="v3-card-board">{boardColumns.map(({status,label})=>{
    const column=visible.filter(card=>card.status===status).sort((a,b)=>{
      const left=status==="queued"?a.queuePositionKey??"":a.positionKey;
      const right=status==="queued"?b.queuePositionKey??"":b.positionKey;
      return left<right?-1:left>right?1:0;
    });
    const hidden=status==="done" && completion && !completion.includeCompleted;
    return <section key={status} className="v3-card-board-column" data-board-column={status} aria-label={label}>
      <div className="v3-detail-section-head"><h3>{label}</h3><span>{column.length}개</span></div>
      <div className="v3-card-board-lane">
        {hidden && column.length>0 ? <div className="v3-card-board-empty"><p>완료 {column.length}개 숨김</p>
          <Button size="sm" variant="ghost" onClick={()=>completion.onChange(true)}>완료 포함 켜기</Button></div>
        : column.length ? column.map(card=><div key={card.id}>{renderCard(card)}</div>)
        : <p className="v3-card-board-empty">카드가 없습니다</p>}
      </div>
    </section>;
  })}</PostItGrid>;
}
