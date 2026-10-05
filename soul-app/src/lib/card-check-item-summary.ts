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
