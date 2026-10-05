import type { CardCheckItem, CardItemDisplay } from '../api/cardTypes';
import type { ColorScheme } from '../theme/colors';

export function summarizeCardItems(items: readonly CardCheckItem[] = []) {
  return {
    total: items.length,
    confirmed: items.filter((item) => item.display === 'confirmed').length,
    unconfirmed: items.filter((item) => item.display !== 'confirmed' && item.display !== 'dropped'),
    needsReview: items.filter((item) => item.display === 'reported' || item.display === 'changed').length,
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
