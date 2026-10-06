import type { CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { cardStatusLabel } from "./CardActions";
import { CardRow as CardRowComponent } from "./CardRow";
import { useCardMembership } from "./use-card-membership";
import "./v3-persistent-task-list.css";

const TASK_STATUSES = ["running", "blocked", "review", "queued", "todo"] as const;
type TaskStatus = typeof TASK_STATUSES[number];
export interface PersistentSessionTaskGroup { status: TaskStatus; label: string; cards: CardRow[] }

/** Applies the whole-board status order and position ordering to shared card membership. */
export function groupPersistentSessionTasks(cards: readonly CardRow[]): PersistentSessionTaskGroup[] {
  return TASK_STATUSES.flatMap(status => {
    const matching = cards.filter(card => card.status === status).sort((left, right) => {
      const leftKey = status === "queued" ? left.queuePositionKey ?? "" : left.positionKey;
      const rightKey = status === "queued" ? right.queuePositionKey ?? "" : right.positionKey;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
    if (matching.length === 0) return [];
    return [{ status, label: cardStatusLabel({ ...matching[0], blockedKind: null }), cards: matching }];
  });
}

export function PersistentSessionTaskList({cards,onOpenCard}: {
  cards?: readonly CardRow[]; onOpenCard(cardId: string): void;
}) {
  if (cards !== undefined) return <TaskListContent cards={cards} onOpenCard={onOpenCard}/>;
  return <ConnectedTaskList onOpenCard={onOpenCard}/>;
}

function ConnectedTaskList({onOpenCard}:{onOpenCard(cardId:string):void}) {
  const membership = useCardMembership(undefined);
  return <TaskListContent cards={membership.cards} loading={membership.loading} error={membership.error} onOpenCard={onOpenCard}/>;
}

function TaskListContent({cards,loading,error,onOpenCard}: {
  cards: readonly CardRow[]; loading?: boolean; error?: string | null; onOpenCard(cardId:string):void;
}) {
  const groups = groupPersistentSessionTasks(cards);
  return <div className="v3-persistent-task-list" data-testid="persistent-session-task-list" aria-busy={loading||undefined}>
    {error?<p className="v3-card-error" role="alert">작업 목록을 불러오지 못했습니다.</p>:null}
    {!error&&loading?<p className="v3-card-board-empty" role="status">불러오는 중…</p>:null}
    {!error&&!loading&&groups.length===0?<p className="v3-card-board-empty">작업이 없습니다.</p>:null}
    {!error?groups.map(group=><section key={group.status} data-task-status-group={group.status} aria-label={group.label}>
      <div className="v3-detail-section-head"><h3>{group.label}</h3></div>
      <div className="v3-run-list">{group.cards.map(card=><CardRowComponent key={card.id} card={card} variant="summary" onOpenCard={onOpenCard}/>)}</div>
    </section>):null}
  </div>;
}
