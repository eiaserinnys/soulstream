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

/** Hides each marked turn through its terminal while preserving dividers and unrelated anchored rows. */
export function projectCacheKeepaliveTurns<T extends Pick<ChatMessage, "treeNodeType" | "cacheKeepalive">
  & Partial<Pick<ChatMessage, "inputId" | "preparedInputId">>>(
  messages: T[],
): T[] {
  const hiddenInputIds = new Set<string>();
  let hidingKeepaliveTurn = false;
  return messages.filter((message) => {
    const isInput = message.treeNodeType === "user_message" || message.treeNodeType === "intervention";
    if (isInput) {
      hidingKeepaliveTurn = message.cacheKeepalive === true;
      if (hidingKeepaliveTurn && message.inputId) hiddenInputIds.add(message.inputId);
      return !hidingKeepaliveTurn;
    }

    if (message.treeNodeType === "generation_started") return true;
    if (hidingKeepaliveTurn && message.treeNodeType === "complete") {
      hidingKeepaliveTurn = false;
      return false;
    }
    if (hidingKeepaliveTurn && message.treeNodeType === "error") {
      hidingKeepaliveTurn = false;
      return true;
    }
    if (hidingKeepaliveTurn) return false;

    const anchorIds = [message.inputId, message.preparedInputId];
    return !anchorIds.some((inputId) => inputId !== undefined && hiddenInputIds.has(inputId));
  });
}
