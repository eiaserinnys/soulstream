export interface TurnSummaryProjectionItem {
  treeNodeId: string;
  treeNodeType: string;
  eventId?: number;
  summaryFinalResponseEventId?: number;
  summaryParentEventId?: number;
}

function isPositiveSafeInteger(value: number | undefined): value is number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0;
}

/**
 * 저장 순서는 바꾸지 않고 실제 렌더 행의 raw event ID에 turn_summary를 결합한다.
 * 유효한 anchor가 아직 화면에 없으면 숨기며, anchor 자체가 없는 legacy summary만
 * durable event ID 순서로 fail-open한다. live와 history 모두 이 한 투영을 지난다.
 */
export function placeTurnSummariesAtResponseAnchors<
  T extends TurnSummaryProjectionItem,
>(items: T[]): T[] {
  const timeline = items.filter((item) => item.treeNodeType !== "turn_summary");
  const summaries = items
    .filter((item) => item.treeNodeType === "turn_summary")
    .sort((a, b) => (a.eventId ?? 0) - (b.eventId ?? 0));
  if (summaries.length === 0) return items;

  const indexByEventId = new Map<number, number>();
  timeline.forEach((item, index) => {
    if (isPositiveSafeInteger(item.eventId)) {
      indexByEventId.set(item.eventId, index);
    }
  });

  const after = new Map<number, T[]>();
  const legacyBefore = new Map<number, T[]>();
  const seenSummaryKeys = new Set<string>();
  for (const summary of summaries) {
    if (seenSummaryKeys.has(summary.treeNodeId)) continue;
    seenSummaryKeys.add(summary.treeNodeId);

    const finalId = summary.summaryFinalResponseEventId;
    const parentId = summary.summaryParentEventId;
    const hasFinal = isPositiveSafeInteger(finalId);
    const hasParent = isPositiveSafeInteger(parentId);
    const anchorIndex = hasFinal
      ? indexByEventId.get(finalId)
      : undefined;
    const fallbackIndex = anchorIndex === undefined && hasParent
      ? indexByEventId.get(parentId)
      : undefined;
    const loadedIndex = anchorIndex ?? fallbackIndex;

    if (loadedIndex !== undefined) {
      const bucket = after.get(loadedIndex) ?? [];
      bucket.push(summary);
      after.set(loadedIndex, bucket);
      continue;
    }
    if (hasFinal || hasParent) continue;

    const summaryId = summary.eventId;
    const insertionIndex = isPositiveSafeInteger(summaryId)
      ? timeline.findIndex(
          (item) => isPositiveSafeInteger(item.eventId) && item.eventId > summaryId,
        )
      : -1;
    const legacyIndex = insertionIndex < 0 ? timeline.length : insertionIndex;
    const bucket = legacyBefore.get(legacyIndex) ?? [];
    bucket.push(summary);
    legacyBefore.set(legacyIndex, bucket);
  }

  const ordered: T[] = [];
  for (let index = 0; index <= timeline.length; index++) {
    ordered.push(...(legacyBefore.get(index) ?? []));
    if (index === timeline.length) break;
    ordered.push(timeline[index]);
    ordered.push(...(after.get(index) ?? []));
  }
  return ordered;
}
