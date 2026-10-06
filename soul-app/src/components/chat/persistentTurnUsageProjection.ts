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
  TurnUsageCaption,
  TurnUsageRenderItem,
} from './groupChatEvents';

type UsageData = Record<string, unknown>;

export function projectPersistentTurnUsage(
  items: readonly ChatRenderItem[],
  events: readonly SessionEvent[],
  showTurnUsage = true,
): ChatRenderItem[] {
  const pairsByTerminalId = new Map(
    pairTurnUsage(events).map((pair) => [String(pair.terminalId), pair]),
  );
  const projected: ChatRenderItem[] = [];

  for (const item of items) {
    if (item.kind !== 'event') {
      projected.push(item);
      continue;
    }

    if (item.event.type === 'context_usage') continue;
    if (item.event.type === 'complete') {
      if (!showTurnUsage) continue;
      const pair = pairsByTerminalId.get(item.event.id);
      const usageItem = makeTurnUsageItem(item, pair?.contextUsage, item.event.data);
      if (usageItem) projected.push(usageItem);
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

    projected.push(item);
  }

  return projected;
}

function makeTurnUsageItem(
  item: Extract<ChatRenderItem, { kind: 'event' }>,
  contextUsage: UsageData | null | undefined,
  completeData: UsageData,
): TurnUsageRenderItem | null {
  const caption = makeTurnUsageCaption(contextUsage, completeData);
  if (!caption) return null;
  return {
    kind: 'turn-usage',
    event: item.event,
    key: item.key,
    title: caption.title,
    ...(caption.expandedTitle !== undefined ? { expandedTitle: caption.expandedTitle } : {}),
    lines: caption.lines,
    summaries: item.summaries,
  };
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
