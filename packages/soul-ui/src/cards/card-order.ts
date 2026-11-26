export interface OrderedCard {
  id: string;
  status: string;
  updatedAt: string;
  statusChangedAt?: string | null;
  queuePositionKey?: string | null;
}

const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const changedAt = (card: OrderedCard) => Date.parse(card.statusChangedAt ?? card.updatedAt);

export function compareStatusChange(left: OrderedCard, right: OrderedCard) {
  return changedAt(right) - changedAt(left) || compareText(right.id, left.id);
}

export function compareCardsInStatus(left: OrderedCard, right: OrderedCard) {
  if (left.status === "queued" && right.status === "queued")
    return compareText(left.queuePositionKey ?? "", right.queuePositionKey ?? "") || compareText(left.id, right.id);
  return compareStatusChange(left, right);
}

export const sortByStatusChange = <T extends OrderedCard>(cards: readonly T[]) => [...cards].sort(compareStatusChange);
export const sortCardsInStatus = <T extends OrderedCard>(cards: readonly T[]) => [...cards].sort(compareCardsInStatus);
