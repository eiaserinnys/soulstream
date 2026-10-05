import type { CardCheckItem, CardItemDisplay } from '../api/cardTypes';
import type { ColorScheme } from '../theme/colors';

export const EMPTY_PENDING_ITEM_CONFIRMATIONS: Record<number, { confirmed: boolean; requestId: string }> = {};

export function summarizeCardItems(
  items: readonly CardCheckItem[] = [],
  pending: Readonly<Record<number, { confirmed: boolean; requestId: string }>> = EMPTY_PENDING_ITEM_CONFIRMATIONS,
) {
  const isConfirmed = (item: CardCheckItem) => pending[item.id]?.confirmed ?? item.display === 'confirmed';
  return {
    total: items.length,
    confirmed: items.filter(isConfirmed).length,
    unconfirmed: items.filter((item) => !isConfirmed(item) && item.display !== 'dropped'),
    needsReview: items.filter((item) => !isConfirmed(item) && (item.display === 'reported' || item.display === 'changed')).length,
  };
}

export function cardItemDisplayColor(display: CardItemDisplay, colors: ColorScheme): string {
  switch (display) {
    case 'doing': return colors.statusRunning;
    case 'reported': return colors.statusCompleted;
    case 'changed': return colors.warning;
    case 'fix': return colors.statusError;
    default: return colors.statusIdle;
  }
}

export function formatCardTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

export function cardItemTargetText(id: number, title?: string): string {
  return `대상: ${id}${title ? ` ${title}` : ''}`;
}

export function cardProgressText(summary: ReturnType<typeof summarizeCardItems>): string {
  return `볼 것 ${summary.needsReview}, 확인 ${summary.confirmed}`;
}
