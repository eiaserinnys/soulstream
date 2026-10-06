export interface AssignedCardContextProjectionItem {
  treeNodeId: string;
  treeNodeType: string;
  eventId?: number;
  inputId?: string;
  preparedInputId?: string;
  assignedCardCount?: number;
}

function validIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validEventId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * The durable debug event may arrive after the response or in another history page.
 * It is displayed only when its exact prepared input identity is currently loaded.
 */
export function placeAssignedCardContextsAtInputAnchors<
  T extends AssignedCardContextProjectionItem,
>(items: T[]): T[] {
  const isPreview = (item: T) => item.treeNodeType === "assigned_card_context";
  const timeline = items.filter(item => !isPreview(item));
  const inputIndexById = new Map<string, number>();
  timeline.forEach((item, index) => {
    if (
      (item.treeNodeType === "user_message" || item.treeNodeType === "intervention")
      && validIdentity(item.inputId)
    ) inputIndexById.set(item.inputId, index);
  });

  const latestByInputId = new Map<string, T>();
  for (const item of items) {
    if (!isPreview(item) || !validIdentity(item.preparedInputId) || !validEventId(item.eventId)) continue;
    const previous = latestByInputId.get(item.preparedInputId);
    if (!previous || !validEventId(previous.eventId) || previous.eventId < item.eventId) {
      latestByInputId.set(item.preparedInputId, item);
    }
  }

  const after = new Map<number, T[]>();
  for (const [inputId, preview] of latestByInputId) {
    const anchorIndex = inputIndexById.get(inputId);
    if (anchorIndex === undefined) continue;
    const bucket = after.get(anchorIndex) ?? [];
    bucket.push(preview);
    bucket.sort((a, b) => (a.eventId ?? 0) - (b.eventId ?? 0));
    after.set(anchorIndex, bucket);
  }

  const ordered: T[] = [];
  timeline.forEach((item, index) => {
    ordered.push(item, ...(after.get(index) ?? []));
  });
  return ordered;
}

/** Empty captures add no information to the manuscript transcript. */
export function projectManuscriptAssignedCardContexts<
  T extends AssignedCardContextProjectionItem,
>(items: T[]): T[] {
  return items.filter((item) => (
    item.treeNodeType !== "assigned_card_context" || item.assignedCardCount !== 0
  ));
}
