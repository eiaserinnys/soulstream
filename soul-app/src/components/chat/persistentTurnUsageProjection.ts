import { pairTurnUsage } from '../../../../packages/soul-ui/src/lib/persistent-turn-usage';
import {
  formatContextUsageText,
  formatTurnCompleteStats,
  formatTurnUsageCaptionTitle,
  TURN_COMPLETE_LABEL,
  TURN_USAGE_SEPARATOR,
} from '../../../../packages/soul-ui/src/lib/turn-usage-format';
import type { SessionEvent } from '../../api/types';
import type {
  ChatRenderItem,
  TurnEndCaptionsRenderItem,
  TurnSummaryRenderItem,
  TurnUsageCaption,
} from './groupChatEvents';
import { isEmptyAssignedCardContextSnapshot } from './turnSummaryProjection';

type UsageData = Record<string, unknown>;

export function projectPersistentTurnUsage(
  items: readonly ChatRenderItem[],
  events: readonly SessionEvent[],
  showTurnUsage = true,
): ChatRenderItem[] {
  const pairsByTerminalId = new Map(
    pairTurnUsage(events).map((pair) => [String(pair.terminalId), pair]),
  );
  const manuscriptItems = items.flatMap((item): ChatRenderItem[] => {
    if (item.kind === 'turn-summary' && isEmptyAssignedCardContextSnapshot(item)) return [];
    if ((item.kind === 'event' || item.kind === 'tool') && item.summaries) {
      const summaries = item.summaries.filter(
        (summary) => !isEmptyAssignedCardContextSnapshot(summary),
      );
      if (summaries.length !== item.summaries.length) {
        return [{ ...item, summaries: summaries.length > 0 ? summaries : undefined }];
      }
    }
    return [item];
  });
  const summariesByCompleteIndex = new Map<number, TurnSummaryRenderItem[]>();
  const fallbackSummariesByAnchorIndex = new Map<number, TurnSummaryRenderItem[]>();
  const pairedSummaryKeys = new Set<string>();

  const pairSummary = (summary: TurnSummaryRenderItem, anchorIndex: number) => {
    if (summary.event.type !== 'turn_summary') return;
    const completeIndex = findFirstCompleteAfterFinalResponse(manuscriptItems, summary);
    const target = completeIndex === null
      ? fallbackSummariesByAnchorIndex
      : summariesByCompleteIndex;
    const targetIndex = completeIndex ?? anchorIndex;
    const bucket = target.get(targetIndex) ?? [];
    bucket.push(summary);
    target.set(targetIndex, bucket);
    if (completeIndex !== null) pairedSummaryKeys.add(summary.key);
  };

  manuscriptItems.forEach((item, index) => {
    if (item.kind === 'event' || item.kind === 'tool') {
      item.summaries?.forEach((summary) => pairSummary(summary, index));
    } else if (item.kind === 'turn-summary' && item.event.type === 'turn_summary') {
      const completeIndex = findFirstCompleteAfterFinalResponse(manuscriptItems, item);
      if (completeIndex !== null) {
        const bucket = summariesByCompleteIndex.get(completeIndex) ?? [];
        bucket.push(item);
        summariesByCompleteIndex.set(completeIndex, bucket);
        pairedSummaryKeys.add(item.key);
      }
    }
  });

  const projected: ChatRenderItem[] = [];

  for (const [index, item] of manuscriptItems.entries()) {
    if (item.kind === 'turn-summary' && item.event.type === 'turn_summary') {
      if (!pairedSummaryKeys.has(item.key)) {
        projected.push(makeSummaryOnlyTurnEnd(item));
      }
      continue;
    }

    if (item.kind !== 'event') {
      if (item.kind === 'tool' && item.summaries?.some((summary) => summary.event.type === 'turn_summary')) {
        const summaries = item.summaries.filter((summary) => summary.event.type !== 'turn_summary');
        projected.push({ ...item, summaries: summaries.length > 0 ? summaries : undefined });
        appendFallbackSummaries(projected, fallbackSummariesByAnchorIndex.get(index));
        continue;
      }
      projected.push(item);
      continue;
    }

    if (item.event.type === 'context_usage') continue;
    if (item.event.type === 'complete') {
      const pair = pairsByTerminalId.get(item.event.id);
      const usage = showTurnUsage
        ? makeTurnUsageCaption(pair?.contextUsage, item.event.data)
        : null;
      const summaries = summariesByCompleteIndex.get(index);
      if (usage || summaries?.length) {
        projected.push(makeTurnEndItem(item, usage, summaries));
      }
      continue;
    }

    if (item.event.type === 'error' && showTurnUsage) {
      const pair = pairsByTerminalId.get(item.event.id);
      const caption = pair?.contextUsage
        ? makeTurnUsageCaption(pair.contextUsage, null)
        : null;
      projected.push(caption ? { ...item, turnUsageCaption: caption } : item);
      continue;
    }

    if (item.summaries?.some((summary) => summary.event.type === 'turn_summary')) {
      const summaries = item.summaries.filter((summary) => summary.event.type !== 'turn_summary');
      projected.push({ ...item, summaries: summaries.length > 0 ? summaries : undefined });
      appendFallbackSummaries(projected, fallbackSummariesByAnchorIndex.get(index));
      continue;
    }
    projected.push(item);
  }

  return projected;
}

function findFirstCompleteAfterFinalResponse(
  items: readonly ChatRenderItem[],
  summary: TurnSummaryRenderItem,
): number | null {
  const finalResponseEventId = positivePayloadEventId(summary.event.data?.final_response_event_id);
  if (finalResponseEventId === null) return null;
  const finalResponseIndex = items.findIndex((item) => renderItemEventIds(item).includes(finalResponseEventId));
  if (finalResponseIndex === -1) return null;

  for (let index = finalResponseIndex + 1; index < items.length; index += 1) {
    const rowEvents = itemEvents(items[index]);
    if (rowEvents.some((event) => isTurnBoundary(event.type))) return null;
    if (rowEvents.some((event) => event.type === 'complete')) return index;
  }
  return null;
}

function positivePayloadEventId(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function renderItemEventIds(item: ChatRenderItem): number[] {
  if (item.kind === 'event') {
    const id = Number(item.event.id);
    return Number.isSafeInteger(id) && id > 0 ? [id] : [];
  }
  if (item.kind === 'tool') {
    return [item.start, item.result].flatMap((event) => {
      if (!event) return [];
      const id = Number(event.id);
      return Number.isSafeInteger(id) && id > 0 ? [id] : [];
    });
  }
  return [];
}

function itemEvents(item: ChatRenderItem): SessionEvent[] {
  if (item.kind === 'event') return [item.event];
  if (item.kind === 'tool') return [item.start, ...(item.result ? [item.result] : [])];
  return [];
}

function isTurnBoundary(type: SessionEvent['type']): boolean {
  return type === 'user_message'
    || type === 'intervention_sent'
    || type === 'generation_started';
}

function makeTurnEndItem(
  item: Extract<ChatRenderItem, { kind: 'event' }>,
  usage: TurnUsageCaption | null,
  summaries: TurnSummaryRenderItem[] | undefined,
): TurnEndCaptionsRenderItem {
  return {
    kind: 'turn-end-captions',
    event: item.event,
    key: item.key,
    ...(usage ? { usage } : {}),
    ...(summaries?.length ? { summaries } : {}),
  };
}

function makeSummaryOnlyTurnEnd(summary: TurnSummaryRenderItem): TurnEndCaptionsRenderItem {
  return {
    kind: 'turn-end-captions',
    event: summary.event,
    key: summary.key,
    summaries: [summary],
  };
}

function appendFallbackSummaries(
  target: ChatRenderItem[],
  summaries: TurnSummaryRenderItem[] | undefined,
) {
  if (!summaries?.length) return;
  const [first, ...rest] = summaries;
  target.push({
    kind: 'turn-end-captions',
    event: first.event,
    key: first.key,
    summaries: [first, ...rest],
  });
}

function makeTurnUsageCaption(
  contextUsage: UsageData | null | undefined,
  completeData: UsageData | null,
): TurnUsageCaption | null {
  const context = contextUsage ?? undefined;
  const complete = completeData ?? undefined;
  const contextText = context
    ? formatContextUsageText({
      usedTokens: context.used_tokens,
      maxTokens: context.max_tokens,
      percent: context.percent,
      estimated: context.estimated,
    })
    : undefined;
  const stats = complete
    ? formatTurnCompleteStats({
      usage: complete.usage,
      turnCostUsd: complete.turn_cost_usd,
      sessionCostUsd: complete.session_cost_usd,
      sessionCostPartial: complete.session_cost_partial,
    })
    : undefined;
  const title = formatTurnUsageCaptionTitle({
    percent: context?.percent,
    estimated: context?.estimated,
    usage: complete?.usage,
    turnCostUsd: complete?.turn_cost_usd,
  });
  const completeText = stats
    ? `${TURN_COMPLETE_LABEL}${TURN_USAGE_SEPARATOR}${stats}`
    : undefined;
  if (!contextText && !title && !stats) return null;

  return {
    title: title ?? TURN_COMPLETE_LABEL,
    ...(contextText || completeText
      ? { expandedTitle: contextText ?? completeText }
      : {}),
    lines: contextText && completeText ? [completeText] : [],
  };
}
