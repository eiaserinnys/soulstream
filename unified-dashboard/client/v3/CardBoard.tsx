import type { ReactNode } from "react";
import { Button } from "@seosoyoung/soul-ui";
import type { CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { PostItGrid } from "./PostItCard";
import type { CardCompletionOption } from "./CardCompletionFilter";
import { CardBoardDnd, CardBoardItem, CardBoardLane } from "./CardBoardDnd";
import "./v3-card-board.css";
import { useBoardPan } from "./use-board-pan";

export const boardColumns = [
  {status:"todo",label:"드래프트"}, {status:"queued",label:"대기"},
  {status:"running",label:"실행 중"}, {status:"blocked",label:"막힘"},
  {status:"review",label:"검수 대기"}, {status:"done",label:"완료"},
] as const;

/** Six fixed lanes. Card rendering and mutations remain with the existing card. */
export function CardBoard({cards, renderCard, completion, draftAction}: {
  cards: readonly CardRow[]; renderCard(card:CardRow,handle:ReactNode,preview?:boolean):ReactNode; draftAction?:ReactNode; completion?:CardCompletionOption;
}) {
  const pan = useBoardPan();
  const visible=cards.filter(card=>!card.archived && card.status!=="cancelled");
  return <CardBoardDnd cards={visible} renderCard={renderCard}><PostItGrid {...pan} className="v3-card-board" variant="compact">{boardColumns.map(({status,label})=>{
    const column=visible.filter(card=>card.status===status).sort((a,b)=>{
      const left=status==="queued"?a.queuePositionKey??"":a.positionKey;
      const right=status==="queued"?b.queuePositionKey??"":b.positionKey;
      return left<right?-1:left>right?1:0;
    });
    const hidden=status==="done" && completion && !completion.includeCompleted;
    return <CardBoardLane key={status} status={status} label={label}>
      <div className="v3-detail-section-head"><h3>{label}</h3><span>{column.length}개</span></div>
      <div className="v3-card-board-lane">
        {status==="todo"?draftAction:null}
        {hidden && column.length>0 ? <div className="v3-card-board-empty"><p>완료 {column.length}개 숨김</p>
          <Button size="sm" variant="ghost" onClick={()=>completion.onChange(true)}>완료 포함 켜기</Button></div>
        : column.length ? column.map(card=><CardBoardItem key={card.id} card={card} renderCard={renderCard}/>)
        : <p className="v3-card-board-empty">카드가 없습니다</p>}
      </div>
    </CardBoardLane>;
  })}</PostItGrid></CardBoardDnd>;
}
