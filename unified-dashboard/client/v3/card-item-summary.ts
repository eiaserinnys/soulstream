import type { CardCheckItem } from "@seosoyoung/soul-ui/cards/card-types";

export interface CardItemSummary {
  activeItems: CardCheckItem[];
  activeCount: number;
  confirmedCount: number;
  toReviewCount: number;
}

/** Counts the server's display values, applying only in-flight confirmation intent. */
export function summarizeCardItems(
  items: readonly CardCheckItem[] | null | undefined,
  pending: Readonly<Record<number, boolean>> = {},
): CardItemSummary {
  const current = items ?? [];
  const isConfirmed = (item: CardCheckItem) => pending[item.id] ?? item.display === "confirmed";
  const activeItems = current.filter(item => !isConfirmed(item) && item.display !== "dropped");
  const confirmedCount = current.filter(item => isConfirmed(item) && item.display !== "dropped").length;
  return {
    activeItems,
    activeCount: activeItems.length,
    confirmedCount,
    toReviewCount: activeItems.filter(item => item.display === "reported" || item.display === "changed").length,
  };
}
