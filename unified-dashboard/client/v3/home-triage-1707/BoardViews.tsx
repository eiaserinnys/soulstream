// 포스트잇 격자와 칸반 보드. 두 화면 모두 운영의 정본 표현 컴포넌트
// (PostItGrid, PostItCardView, CardBoardWorkspace)를 그대로 쓰고 자료만 시안에서 가져온다.
import { useMemo, useState } from "react";

import "../v3-postit-cards.css";
import "../v3-card-board.css";

import { CardBoardWorkspace } from "../CardBoardWorkspace";
import { PostItCardView, PostItGrid } from "../PostItCard";
import {
  boardCardSessionSummary,
  boardCardToCardRow,
  type BoardCard,
} from "./triage-data";

export function PostItBoardGrid({ cards, onOpen }: { cards: BoardCard[]; onOpen(id: string): void }) {
  return (
    <div className="v3-ht-grid-scroll">
      <PostItGrid className="v3-ht-postit-grid" data-testid="v3-ht-postit-grid">
        {cards.map(card => {
          const row = boardCardToCardRow(card);
          return (
            <PostItCardView
              key={card.id}
              card={row}
              activity={row.latestActivity ?? null}
              assignee={boardCardSessionSummary(card)}
              onOpen={() => onOpen(card.id)}
            />
          );
        })}
      </PostItGrid>
    </div>
  );
}

export function KanbanBoard({ cards, onOpen }: { cards: BoardCard[]; onOpen(id: string): void }) {
  const [includeCompleted, setIncludeCompleted] = useState(true);
  const rows = useMemo(() => cards.map(boardCardToCardRow), [cards]);
  const sources = useMemo(() => new Map(cards.map(card => [card.id, card])), [cards]);

  return (
    <div className="v3-ht-board-scroll" data-testid="v3-ht-board">
      <CardBoardWorkspace
        title="전체 카드"
        cards={rows}
        completion={{ includeCompleted, onChange: setIncludeCompleted }}
        renderCard={card => {
          const source = sources.get(card.id);
          return (
            <PostItCardView
              card={card}
              activity={card.latestActivity ?? null}
              assignee={source ? boardCardSessionSummary(source) : undefined}
              onOpen={() => onOpen(card.id)}
            />
          );
        }}
      />
    </div>
  );
}
