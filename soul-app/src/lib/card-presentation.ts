import type { CardDto, CardStatus } from '../api/cardTypes';

export const CARD_STATUS_LABEL: Record<CardStatus, string> = {
  todo: '할 일', queued: '대기', blocked: '막힘', running: '실행 중', review: '검수', done: '완료', cancelled: '취소',
};
export function cardPrimaryAction(card: Pick<CardDto, 'status' | 'blockedKind'>) {
  if (card.status === 'review') return 'review';
  if (card.status === 'blocked' && card.blockedKind === 'question') return 'answer';
  if (card.status === 'blocked' || card.status === 'todo') return 'queue';
  if (card.status === 'queued') return 'remove';
  return null;
}
export function queueAfterCardId(
  sourceId: string, dropY: number, layouts: readonly { id: string; top: number; height: number }[],
) {
  const others = layouts.filter((row) => row.id !== sourceId);
  const before = others.findIndex((row) => dropY < row.top + row.height / 2);
  return before === 0 ? null : before < 0 ? others.at(-1)?.id ?? null : others[before - 1].id;
}
