import type { CardDto, CardStatus } from '../api/cardTypes';
import { CARD_STATUS_LABEL } from './card-presentation';
import { BOARD_COLUMNS } from './card-board-layout';

export const PERSISTENT_SESSION_TASK_STATUSES = ['running', 'blocked', 'review', 'queued', 'todo'] as const;
export type PersistentSessionTaskStatus = typeof PERSISTENT_SESSION_TASK_STATUSES[number];

export interface PersistentSessionTaskGroup {
  status: PersistentSessionTaskStatus;
  label: string;
  cards: CardDto[];
}

function positionKey(card: CardDto, status: CardStatus): string {
  return status === 'queued' ? card.queuePositionKey ?? '' : card.positionKey;
}

function compareCardPosition(left: CardDto, right: CardDto, status: CardStatus): number {
  const leftKey = positionKey(left, status);
  const rightKey = positionKey(right, status);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

export function groupPersistentSessionTasks(cards: readonly CardDto[]): PersistentSessionTaskGroup[] {
  return PERSISTENT_SESSION_TASK_STATUSES.flatMap((status) => {
    const matching = cards.filter((card) => card.status === status)
      .sort((left, right) => compareCardPosition(left, right, status));
    if (matching.length === 0) return [];
    const label = status === 'todo'
      ? BOARD_COLUMNS.find(([columnStatus]) => columnStatus === 'todo')![1]
      : CARD_STATUS_LABEL[status];
    return [{ status, label, cards: matching }];
  });
}
