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
      projected.push(makeTurnUsageItem(item, pair?.contextUsage, item.event.data));
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
): TurnUsageRenderItem {
  const caption = makeTurnUsageCaption(contextUsage, completeData);
  return {
    kind: 'turn-usage',
    event: item.event,
    key: item.key,
    title: caption.title,
    lines: caption.lines,
    summaries: item.summaries,
  };
}

function makeTurnUsageCaption(
  contextUsage: UsageData | null | undefined,
  completeData: UsageData,
): TurnUsageCaption;
function makeTurnUsageCaption(
  contextUsage: UsageData | null | undefined,
  completeData: UsageData | null,
): TurnUsageCaption | null;
function makeTurnUsageCaption(
  contextUsage: UsageData | null | undefined,
  completeData: UsageData | null,
): TurnUsageCaption | null {
  const context = contextUsage ?? undefined;
  const complete = completeData ?? undefined;
  const title = formatTurnUsageCaptionTitle({
    percent: context?.percent,
    estimated: context?.estimated,
    usage: complete?.usage,
    turnCostUsd: complete?.turn_cost_usd,
  });
  if (!complete && !title) return null;

  const lines: string[] = [];
  const contextText = context
    ? formatContextUsageText({
      usedTokens: context.used_tokens,
      maxTokens: context.max_tokens,
      percent: context.percent,
      estimated: context.estimated,
    })
    : undefined;
  if (contextText) lines.push(contextText);

  if (complete) {
    const stats = formatTurnCompleteStats({
      usage: complete.usage,
      turnCostUsd: complete.turn_cost_usd,
      sessionCostUsd: complete.session_cost_usd,
      sessionCostPartial: complete.session_cost_partial,
    });
    lines.push(stats
      ? `${TURN_COMPLETE_LABEL}${TURN_USAGE_SEPARATOR}${stats}`
      : TURN_COMPLETE_LABEL);
  }

  return {
    title: title ?? TURN_COMPLETE_LABEL,
    lines,
  };
}
