import type { ChatMessage } from "./flatten-tree";

export const SILENT_MANUSCRIPT_TOKEN = "[SILENT]";

export function isManuscriptSilentTokenText(
  content: string | undefined,
  isStreaming = false,
): boolean {
  const trimmed = content?.trim() ?? "";
  return trimmed === SILENT_MANUSCRIPT_TOKEN
    || (isStreaming && trimmed.length > 0 && SILENT_MANUSCRIPT_TOKEN.startsWith(trimmed));
}

export function isStandaloneKoreanYesAck(content: string | undefined): boolean {
  const trimmed = content?.trim();
  return trimmed === "네." || trimmed === "네";
}

function isAgentReport(message: ChatMessage): boolean {
  if (message.role !== "user" && message.role !== "intervention") return false;

  if (message.callerInfo) return message.callerInfo.source === "agent";
  return message.role === "user" && message.agentInfo?.source === "agent";
}

function isAutomaticDeliveryNotice(message: ChatMessage): boolean {
  return message.role === "notification"
    && (message.deliveryIntent === "completion_notification"
      || message.deliveryIntent === "runtime_followup");
}

function isCacheKeepaliveTurn(message: ChatMessage): boolean {
  const purpose = (message as ChatMessage & { purpose?: unknown }).purpose;
  return message.cacheKeepalive === true || purpose === "cache_keepalive";
}

function hasManuscriptAttachment(message: ChatMessage): boolean {
  const attachmentFields = message as ChatMessage & {
    attachments?: unknown[];
    outputAttachments?: unknown[];
  };
  return (attachmentFields.attachments?.length ?? 0) > 0
    || (attachmentFields.outputAttachments?.length ?? 0) > 0
    || (message.attachmentPaths?.length ?? 0) > 0
    || (message.attachmentIds?.length ?? 0) > 0
    || (message.attachmentCount ?? 0) > 0;
}

function isManuscriptTurnOpener(message: ChatMessage): boolean {
  return message.role === "user"
    || message.role === "intervention"
    || message.role === "notification";
}

function isHiddenManuscriptTurnOpener(message: ChatMessage): boolean {
  return isAgentReport(message) || isAutomaticDeliveryNotice(message);
}

function isManuscriptTurnEndCaption(message: ChatMessage): boolean {
  return message.treeNodeType === "complete"
    || message.treeNodeType === "context_usage"
    || message.treeNodeType === "turn_summary"
    || message.treeNodeType === "persistent_instruction_recorded"
    || message.treeNodeType === "persistent_jev_candidates";
}

function hideOrphanedManuscriptTurnCaptions(messages: ChatMessage[]): ChatMessage[] {
  const removedIndexes = new Set<number>();
  let turnStartIndex = -1;
  let allOpenersHidden = false;
  let hasSurvivingResponseOrError = false;
  let hasResponseOrEnd = false;

  const finishTurn = (endIndex: number) => {
    if (turnStartIndex < 0 || !allOpenersHidden || hasSurvivingResponseOrError) return;
    for (let index = turnStartIndex; index < endIndex; index += 1) {
      if (isManuscriptTurnEndCaption(messages[index])) removedIndexes.add(index);
    }
  };

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (isManuscriptTurnOpener(message)) {
      const hidden = isHiddenManuscriptTurnOpener(message);
      const joinsHiddenOpeners = turnStartIndex >= 0
        && allOpenersHidden
        && !hasResponseOrEnd
        && hidden;

      if (!joinsHiddenOpeners) {
        finishTurn(index);
        turnStartIndex = index;
        allOpenersHidden = hidden;
        hasSurvivingResponseOrError = false;
        hasResponseOrEnd = false;
      }
      continue;
    }

    if (turnStartIndex < 0) continue;
    if (message.role === "assistant" || message.treeNodeType === "error") {
      hasSurvivingResponseOrError = true;
      hasResponseOrEnd = true;
    } else if (message.treeNodeType === "complete") {
      hasResponseOrEnd = true;
    }
  }

  finishTurn(messages.length);
  return messages.filter((_, index) => !removedIndexes.has(index));
}

/** Removes silent responses from delegated and report-closed PAS turns. */
export function projectManuscriptSilentResponses(messages: ChatMessage[]): ChatMessage[] {
  let inSuppressedTurn = false;

  const responsesFiltered = messages.filter(message => {
    const startsTurn = isManuscriptTurnOpener(message);

    if (startsTurn) {
      inSuppressedTurn = isAgentReport(message)
        || isAutomaticDeliveryNotice(message)
        || isCacheKeepaliveTurn(message)
        || (Array.isArray(message.contextItems)
          && message.contextItems.some(item => item?.key === "persistent_report_closed"));
    }

    if (
      message.role !== "assistant"
      || (
        message.treeNodeType !== "text"
        && message.treeNodeType !== "assistant_message"
        && message.treeNodeType !== undefined
      )
      || hasManuscriptAttachment(message)
    ) {
      return true;
    }

    if (isManuscriptSilentTokenText(message.content, message.isStreaming)) return false;
    return !(inSuppressedTurn && isStandaloneKoreanYesAck(message.content));
  });

  return hideOrphanedManuscriptTurnCaptions(responsesFiltered);
}

/** Removes internal delivery notices and agent reports from PAS manuscript rows. */
export function projectManuscriptMessages(messages: ChatMessage[]): ChatMessage[] {
  return projectManuscriptSilentResponses(messages)
    .filter(message => !isAutomaticDeliveryNotice(message) && !isAgentReport(message));
}
