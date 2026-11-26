import type { PlannerToday } from '../api/plannerTypes';
import { sortByStatusChange, sortCardsInStatus } from '../../../packages/soul-ui/src/cards/card-order';
import { mergeCardRows, useCardStore } from '../store/cardStore';

/** Both the date summary and visible sections use the same live card inventory. */
export function useTodayCardGroups(data: PlannerToday | undefined) {
  const updates = useCardStore((state) => state.rows);
  const cards = mergeCardRows([...(data?.attention ?? []), ...(data?.running ?? []), ...(data?.queued ?? [])], updates);
  return [
    { title: '확인할 것', status: 'attention', cards: sortByStatusChange(cards.filter((card) => card.status === 'review' || card.status === 'blocked')) },
    { title: '진행 중', status: 'running', cards: sortByStatusChange(cards.filter((card) => card.status === 'running')) },
    { title: '대기열', status: 'queued', cards: sortCardsInStatus(cards.filter((card) => card.status === 'queued')) },
  ];
}
