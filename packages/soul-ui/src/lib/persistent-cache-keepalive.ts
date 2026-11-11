import type { ChatMessage } from "./flatten-tree";

export const CACHE_KEEPALIVE_PURPOSE = "cache_keepalive";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads both the producer's flat event field and a persisted payload wrapper. */
export function isCacheKeepaliveInput(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const payload = isRecord(value.payload) ? value.payload : undefined;
  return value.purpose === CACHE_KEEPALIVE_PURPOSE
    || payload?.purpose === CACHE_KEEPALIVE_PURPOSE;
}

/** Hides marked inputs and their output while preserving dividers and errors. */
export function projectHiddenInputTurns<T extends Pick<ChatMessage, "treeNodeType" | "cacheKeepalive" | "cardNotice">
  & Partial<Pick<ChatMessage, "inputId" | "preparedInputId">>>(
  messages: T[],
): { messages: T[]; suppressStreaming: boolean } {
  const hiddenInputIds = new Set<string>();
  const activeHiddenInputIds = new Set<string>();
  let hiding = false;
  let hasVisibleInput = false;
  const visible = messages.filter((message) => {
    const isInput = message.treeNodeType === "user_message" || message.treeNodeType === "intervention";
    if (isInput) {
      const hiddenInput = message.cacheKeepalive === true || message.cardNotice === true;
      if (!hiddenInput) {
        if (hiding) activeHiddenInputIds.forEach((id) => hiddenInputIds.delete(id));
        activeHiddenInputIds.clear();
        hiding = false;
        hasVisibleInput = true;
        return true;
      }
      if (message.cacheKeepalive || !hasVisibleInput) hiding = true;
      if (hiding && message.inputId) {
        hiddenInputIds.add(message.inputId);
        activeHiddenInputIds.add(message.inputId);
      }
      return false;
    }

    if (message.treeNodeType === "generation_started") return true;
    // 질문 닫힘은 그려지지 않고 접기가 앞선 질문 줄의 칩만 바꾼다. 숨긴 턴 안에 도착해도 접기까지 보낸다.
    if (message.treeNodeType === "report_timeline_question_closed") return true;
    if (message.treeNodeType === "complete" || message.treeNodeType === "error") {
      const wasHiding = hiding;
      hiding = false;
      hasVisibleInput = false;
      activeHiddenInputIds.clear();
      return !wasHiding || message.treeNodeType === "error";
    }
    if (hiding) return false;

    const anchorIds = [message.inputId, message.preparedInputId];
    return !anchorIds.some((inputId) => inputId !== undefined && hiddenInputIds.has(inputId));
  });
  return { messages: visible, suppressStreaming: hiding };
}
