import type { CardDto } from '../api/cardTypes';
import { CARD_STATUS_LABELS } from '../../../packages/wire-schema/src/card_status_labels';
import { sortCardsInStatus } from '../../../packages/soul-ui/src/cards/card-order';
import { BOARD_COLUMNS } from './card-board-layout';

export const PERSISTENT_SESSION_TASK_STATUSES = ['running', 'blocked', 'awaiting_verification', 'review', 'queued', 'todo'] as const;
export type PersistentSessionTaskStatus = typeof PERSISTENT_SESSION_TASK_STATUSES[number];

export interface PersistentSessionTaskGroup {
  status: PersistentSessionTaskStatus;
  label: string;
  cards: CardDto[];
}

export function groupPersistentSessionTasks(cards: readonly CardDto[]): PersistentSessionTaskGroup[] {
  return PERSISTENT_SESSION_TASK_STATUSES.flatMap((status) => {
    const matching = sortCardsInStatus(cards.filter((card) => card.status === status));
    if (matching.length === 0) return [];
    const label = status === 'todo'
      ? BOARD_COLUMNS.find(([columnStatus]) => columnStatus === 'todo')![1]
      : CARD_STATUS_LABELS[status];
    return [{ status, label, cards: matching }];
  });
}
