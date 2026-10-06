import type { CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { Button } from "@seosoyoung/soul-ui";
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
  return <TaskListContent cards={membership.cards} loading={membership.loading} error={membership.error} retry={membership.retry} onOpenCard={onOpenCard}/>;
}

function TaskListContent({cards,loading,error,retry,onOpenCard}: {
  cards: readonly CardRow[]; loading?: boolean; error?: string | null; retry?:()=>void; onOpenCard(cardId:string):void;
}) {
  const groups = groupPersistentSessionTasks(cards);
  const numberedCards=groups.flatMap(group=>group.cards).filter(card=>card.number!==undefined&&card.number!==null);
  const widestNumber=numberedCards.reduce<number|null>((widest,card)=>widest===null||String(card.number).length>String(widest).length?card.number!:widest,null);
  const summaryNumberTemplate=widestNumber===null?undefined:`#${widestNumber}`;
  return <div className="v3-persistent-task-list" data-testid="persistent-session-task-list" aria-busy={loading&&!error||undefined}>
    {error?<div className="v3-persistent-task-list-error" role="alert"><span className="v3-card-error">작업 목록을 불러오지 못했습니다.</span>{retry?<Button size="sm" variant="outline" className="v3-persistent-task-paper-button" onClick={retry}>다시 시도</Button>:null}</div>:null}
    {!error&&loading?<p className="v3-card-board-empty" role="status">불러오는 중…</p>:null}
    {!error&&!loading&&groups.length===0?<p className="v3-card-board-empty">카드가 없습니다.</p>:null}
    {!error?groups.map(group=><section key={group.status} data-task-status-group={group.status} aria-label={group.label}>
      <div className="v3-detail-section-head v3-persistent-task-group-label"><h3>{group.label}</h3></div>
      <div className="v3-run-list">{group.cards.map(card=><CardRowComponent key={card.id} card={card} variant="summary" summaryNumberTemplate={summaryNumberTemplate} onOpenCard={onOpenCard}/>)}</div>
    </section>):null}
  </div>;
}
