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

/** Removes each marked input and every row through the next model input. */
export function projectCacheKeepaliveTurns<T extends Pick<ChatMessage, "treeNodeType" | "cacheKeepalive">>(
  messages: T[],
): T[] {
  let hidingKeepaliveTurn = false;
  return messages.filter((message) => {
    const isInput = message.treeNodeType === "user_message" || message.treeNodeType === "intervention";
    if (isInput) {
      hidingKeepaliveTurn = message.cacheKeepalive === true;
      return !hidingKeepaliveTurn;
    }
    return !hidingKeepaliveTurn;
  });
}
