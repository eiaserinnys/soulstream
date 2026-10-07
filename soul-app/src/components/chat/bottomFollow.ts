export const INVERTED_LIST_BOTTOM_THRESHOLD = 10;

export function isNearInvertedListBottom(
  offsetY: number,
  threshold = INVERTED_LIST_BOTTOM_THRESHOLD,
): boolean {
  return offsetY <= threshold;
}

export function bottomFollowTargetKey<T extends { key: string; kind?: string }>(
  items: readonly T[],
): string | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i] as T & { event?: { type?: string } };
    if (
      item.kind !== 'typing'
      && !(item.kind === 'event' && item.event?.type === 'generation_started')
    ) return item.key;
  }
  return items.length > 0 ? items[items.length - 1].key : null;
}

export function shouldFollowNewBottomItem({
  wasAtBottom,
  previousKey,
  nextKey,
}: {
  wasAtBottom: boolean;
  previousKey: string | null;
  nextKey: string | null;
}): boolean {
  return Boolean(wasAtBottom && nextKey && previousKey !== nextKey);
}
