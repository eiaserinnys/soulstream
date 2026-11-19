// 포스트잇 격자와 칸반 보드. 두 화면 모두 운영의 순수 표현 컴포넌트(PostItGrid, PostItCardView)를
// 그대로 쓰고, 자료만 시안 장부에서 가져온다.
import "../v3-postit-cards.css";
import "../v3-card-board.css";

import { PostItCardView, PostItGrid } from "../PostItCardPresentation";
import { StatusChip } from "../StatusChip";
import { boardStatusLabel, type BoardCard, type BoardStatus, type TriageCard } from "./triage-data";

const BOARD_ORDER: readonly BoardStatus[] = ["todo", "queued", "blocked", "running", "review", "on_hold", "done"];

const BOARD_TONE: Record<BoardStatus, string> = {
  todo: "open",
  queued: "queued",
  running: "running",
  blocked: "blocked",
  review: "review",
  on_hold: "open",
  done: "done",
};

export function PostItBoardGrid({ cards, onOpen }: { cards: TriageCard[]; onOpen(id: string): void }) {
  return (
    <div className="v3-ht-grid-scroll">
      <PostItGrid fontSize={15} className="v3-ht-postit-grid" data-testid="v3-ht-postit-grid">
        {cards.map(card => (
          <PostItCardView
            key={card.id}
            id={card.id}
            title={card.title}
            status={card.kind}
            color={card.color}
            fontSize={15}
            activity={{ kind: "report", text: card.items[0]?.result ?? card.scope }}
            assigneeName={card.session.agentName}
            summary={<span className="v3-postit-summary v3-ht-postit-kicker">#{card.number} {card.folderLabel}</span>}
            statusContent={<StatusChip label={card.kind} tone={card.tone} />}
            supplement={card.waited}
            onOpen={() => onOpen(card.id)}
          />
        ))}
      </PostItGrid>
    </div>
  );
}

export function KanbanBoard({ cards, onOpen }: { cards: BoardCard[]; onOpen(id: string): void }) {
  return (
    <div className="v3-ht-board-scroll">
      <PostItGrid fontSize={13} variant="compact" className="v3-card-board v3-ht-board" data-testid="v3-ht-board">
        {BOARD_ORDER.map(status => {
          const column = cards.filter(card => card.status === status);
          return (
            <section key={status} className="v3-card-board-column" data-board-column={status} aria-label={boardStatusLabel(status)}>
              <div className="v3-detail-section-head">
                <h3>{boardStatusLabel(status)}</h3>
                <span data-testid={`v3-ht-board-count-${status}`}>{column.length}개</span>
              </div>
              <div className="v3-card-board-lane">
                {column.length === 0 ? <p className="v3-card-board-empty">카드가 없습니다</p> : null}
                {column.map(card => (
                  <PostItCardView
                    key={card.id}
                    id={card.id}
                    title={card.title}
                    status={boardStatusLabel(status)}
                    color={card.color}
                    fontSize={13}
                    variant="compact"
                    activity={{ kind: "report", text: card.activity }}
                    assigneeName={card.assigneeEmoji}
                    summary={<span className="v3-postit-summary v3-ht-postit-kicker">#{card.number}</span>}
                    statusContent={<StatusChip label={boardStatusLabel(status)} tone={BOARD_TONE[status]} />}
                    supplement={card.folderLabel}
                    onOpen={() => onOpen(card.id)}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </PostItGrid>
    </div>
  );
}
