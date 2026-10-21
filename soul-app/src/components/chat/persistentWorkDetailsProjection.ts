import type { ChatRenderItem, TurnSummaryRenderItem } from './groupChatEvents';

type SummaryFieldItem = Extract<
  ChatRenderItem,
  { kind: 'event' | 'tool' | 'turn-usage' }
> & { summaries?: TurnSummaryRenderItem[] };

function hasSummaryField(item: ChatRenderItem): item is SummaryFieldItem {
  return item.kind === 'event' || item.kind === 'tool' || item.kind === 'turn-usage';
}

/**
 * PAS 작업 세부 표시가 꺼져 있을 때 요약 줄과 도구 활동 줄을 걷어낸다.
 * 그룹핑 결과는 그대로 두고 표시 단계에서만 제거한다.
 */
export function projectPersistentWorkDetails(items: ChatRenderItem[]): ChatRenderItem[] {
  const projected: ChatRenderItem[] = [];
  for (const item of items) {
    if (item.kind === 'activity' || item.kind === 'turn-summary') continue;
    if (item.kind === 'turn-end-captions') {
      const { summaries, ...rest } = item;
      if (summaries === undefined) {
        projected.push(item);
        continue;
      }
      if (!rest.usage && !rest.persistentInstructionRecorded) continue;
      projected.push(rest);
      continue;
    }
    if (hasSummaryField(item)) {
      if (item.summaries === undefined) {
        projected.push(item);
        continue;
      }
      projected.push({ ...item, summaries: undefined });
      continue;
    }
    projected.push(item);
  }
  return projected;
}
