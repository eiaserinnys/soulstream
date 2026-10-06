import { pairTurnUsage } from "./persistent-turn-usage";
import type { ChatMessage } from "./flatten-tree";
import { formatContextUsageText, formatTurnCompleteStats, formatTurnUsageCaptionTitle, TURN_COMPLETE_LABEL, TURN_USAGE_SEPARATOR } from "./turn-usage-format";

/** Adds PAS usage captions while leaving default transcript messages untouched. */
export function projectPersistentTurnUsage(
  messages: ChatMessage[],
  showTurnUsage: boolean,
): ChatMessage[] {
  const sourceMessages = messages.filter((message) => (
    message.treeNodeType === "context_usage"
    || message.treeNodeType === "complete"
    || message.treeNodeType === "error"
    || message.treeNodeType === "user_message"
    || message.treeNodeType === "intervention"
    || message.treeNodeType === "generation_started"
  ));
  // flattenTree follows the event-sorted tree and event processing removes duplicate durable IDs.
  const pairs = pairTurnUsage(sourceMessages.map((message) => {
    const id = message.eventId ?? message.id;
    return {
      id,
      type: message.treeNodeType === "intervention" ? "intervention_sent" : message.treeNodeType,
      data: message,
    };
  }));

  const captions = new Map<string, NonNullable<ChatMessage["turnUsageCaption"]>>();
  for (const pair of pairs) {
    if (pair.terminalType === "complete" && showTurnUsage) {
      const contextMessage = pair.contextUsage;
      const context = contextMessage?.contextUsageData;
      const complete = pair.complete;
      const contextText = context ? formatContextUsageText(context) : undefined;
      const stats = complete ? formatTurnCompleteStats({
        usage: complete.usage,
        turnCostUsd: complete.turnCostUsd,
        sessionCostUsd: complete.sessionCostUsd,
        sessionCostPartial: complete.sessionCostPartial,
      }) : undefined;
      const completeText = stats ? `${TURN_COMPLETE_LABEL}${TURN_USAGE_SEPARATOR}${stats}` : undefined;
      const title = formatTurnUsageCaptionTitle({
        percent: context?.percent,
        estimated: context?.estimated,
        usage: complete?.usage,
        turnCostUsd: complete?.turnCostUsd,
      }) ?? contextText;

      if (complete && title && (contextText || completeText)) {
        captions.set(String(pair.terminalId), {
          title,
          contextText,
          completeText,
        });
      }
    } else if (pair.terminalType === "error" && showTurnUsage) {
      const context = pair.contextUsage?.contextUsageData;
      if (!context) continue;
      const contextText = formatContextUsageText(context);
      const title = formatTurnUsageCaptionTitle({
        percent: context.percent,
        estimated: context.estimated,
      }) ?? contextText;
      if (title && contextText) {
        captions.set(String(pair.terminalId), { title, contextText });
      }
    }
  }

  return messages.flatMap((message) => {
    if (message.treeNodeType === "context_usage") return [];
    if (message.treeNodeType === "complete") {
      if (!showTurnUsage) return message.turnSummaryCaption ? [message] : [];
      const caption = captions.get(String(message.eventId ?? message.id));
      if (caption) return [{ ...message, turnUsageCaption: caption }];
      return message.turnSummaryCaption ? [message] : [];
    }
    if (message.treeNodeType === "error") {
      const caption = captions.get(String(message.eventId ?? message.id));
      return caption ? [{ ...message, turnUsageCaption: caption }] : [message];
    }
    return [message];
  });
}
