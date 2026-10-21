import type {
  ChatEventRenderItem,
  ChatRenderItem,
  TurnSummaryRenderItem,
} from './groupChatEvents';

type SummaryFieldItem = Extract<
  ChatRenderItem,
  { kind: 'event' | 'tool' | 'turn-usage' }
> & { summaries?: TurnSummaryRenderItem[] };

function hasSummaryField(item: ChatRenderItem): item is SummaryFieldItem {
  return item.kind === 'event' || item.kind === 'tool' || item.kind === 'turn-usage';
}

function isTurnSummary(item: TurnSummaryRenderItem): boolean {
  return item.event.type === 'turn_summary';
}

function isNarrationCandidate(item: ChatRenderItem): item is ChatEventRenderItem {
  return item.kind === 'event'
    && (item.event.type === 'assistant_message' || item.event.type === 'text_delta')
    && item.event.data?.ui === undefined;
}

function stripSummaries<T extends { summaries?: TurnSummaryRenderItem[] }>(item: T): T {
  if (item.summaries === undefined) return item;
  const kept = item.summaries.filter((entry) => !isTurnSummary(entry));
  if (kept.length === item.summaries.length) return item;
  return { ...item, summaries: kept.length === 0 ? undefined : kept };
}

/**
 * PAS 작업 세부 표시가 꺼져 있을 때 요약 줄과 도구 활동 줄을 걷어낸다.
 * 활동 앞 서술은 표식으로 원고형 서술 크기를 유지하고, 담당 카드 칩은 남긴다.
 */
export function projectPersistentWorkDetails(items: ChatRenderItem[]): ChatRenderItem[] {
  const projected: ChatRenderItem[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.kind === 'activity') {
      const previous = items[index - 1];
      if (previous && isNarrationCandidate(previous)) {
        // 바로 앞 응답은 이미 요약을 걷어낸 채 projected 끝에 있다. 원본이 아니라 그 값을 쓴다.
        const last = projected[projected.length - 1] as ChatEventRenderItem;
        projected[projected.length - 1] = { ...last, manuscriptNarration: true };
      }
      continue;
    }
    if (item.kind === 'turn-summary') {
      if (isTurnSummary(item)) continue;
      projected.push(item);
      continue;
    }
    if (item.kind === 'turn-end-captions') {
      const next = stripSummaries(item);
      if (!next.usage && !next.persistentInstructionRecorded && next.summaries === undefined) continue;
      projected.push(next);
      continue;
    }
    if (hasSummaryField(item)) {
      projected.push(stripSummaries(item));
      continue;
    }
    projected.push(item);
  }
  return projected;
}
