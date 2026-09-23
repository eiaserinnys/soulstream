const SEARCH_PREVIEW_RADIUS = 100;

export const SEARCH_EVENT_TYPES_BY_CATEGORY = {
  messages: ["user_message", "intervention_sent"],
  responses: ["assistant_message", "result", "complete"],
  thinking: ["thinking"],
  tools: ["tool_start", "tool_result"],
} as const;

export type SearchEventCategory = keyof typeof SEARCH_EVENT_TYPES_BY_CATEGORY;

export const DEFAULT_SEARCH_CATEGORIES = [
  "messages",
  "responses",
] as const satisfies readonly SearchEventCategory[];

export type SessionSearchIntent = {
  readonly sessionId: string;
  readonly eventId?: string;
};

export function normalizeSearchQuery(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function compactSearchQuery(value: string): string {
  return normalizeSearchQuery(value).replace(/\s+/g, "");
}

export function buildSessionSearchUrl(intent: SessionSearchIntent): string {
  const params = new URLSearchParams();
  params.set("session", intent.sessionId);
  if (intent.eventId !== undefined && intent.eventId.length > 0) {
    params.set("event", intent.eventId);
  }
  return `/?${params.toString()}`;
}

export function parseSessionSearchIntent(
  value: string | URL,
): SessionSearchIntent | null {
  const url = value instanceof URL
    ? value
    : new URL(value, "https://session-intent.invalid");
  const sessionId = url.searchParams.get("session");
  if (sessionId) {
    const eventId = url.searchParams.get("event") ?? undefined;
    return { sessionId, ...(eventId === undefined ? {} : { eventId }) };
  }

  const legacy = url.hash.match(/^#\/feed\/([^/?#]+)(?:\?event=([^&#]+))?$/);
  if (!legacy?.[1]) return null;
  try {
    const legacySessionId = decodeURIComponent(legacy[1]);
    const legacyEventId = legacy[2] === undefined
      ? undefined
      : decodeURIComponent(legacy[2]);
    return {
      sessionId: legacySessionId,
      ...(legacyEventId === undefined ? {} : { eventId: legacyEventId }),
    };
  } catch {
    return null;
  }
}

export function removeSessionSearchIntent(value: string | URL): string {
  const url = value instanceof URL
    ? new URL(value.toString())
    : new URL(value, "https://session-intent.invalid");
  const hasQueryIntent = url.searchParams.has("session");
  const wasLegacyIntent = url.searchParams.get("session") === null
    && /^#\/feed\/[^/?#]+(?:\?event=[^&#]+)?$/.test(url.hash);
  if (hasQueryIntent) {
    url.searchParams.delete("session");
    url.searchParams.delete("event");
  }
  if (wasLegacyIntent) url.hash = "";
  return `${url.pathname}${url.search}${url.hash}`;
}

export function isSearchEventCategory(value: string): value is SearchEventCategory {
  return Object.hasOwn(SEARCH_EVENT_TYPES_BY_CATEGORY, value);
}

export function eventTypesForSearchCategories(
  categories: readonly SearchEventCategory[],
): string[] {
  return categories.flatMap((category) => [...SEARCH_EVENT_TYPES_BY_CATEGORY[category]]);
}

const SEARCH_EVENT_TYPE_LABELS: Readonly<Record<string, string>> = {
  user_message: "User",
  intervention_sent: "User",
  assistant_message: "Assistant",
  result: "Assistant",
  complete: "Assistant",
  thinking: "Thinking",
  tool_start: "Tool",
  tool_result: "Tool",
};

export function searchEventTypeLabel(eventType: string): string {
  return SEARCH_EVENT_TYPE_LABELS[eventType] ?? eventType;
}

export function parseSearchEventCategories(
  value: string | undefined,
): SearchEventCategory[] | null {
  if (value === undefined) return null;
  const categories = value
    .split(",")
    .map((item) => item.trim())
    .filter(isSearchEventCategory);
  return categories;
}

export function buildSearchPreview(text: string, query: string): string {
  if (!text) return "";
  const lower = text.toLowerCase();
  const index = lower.indexOf(query.toLowerCase());
  if (index < 0) {
    return sliceOnCodePointBoundary(text, 0, SEARCH_PREVIEW_RADIUS * 2);
  }
  const start = Math.max(0, index - SEARCH_PREVIEW_RADIUS);
  const end = Math.min(text.length, index + query.length + SEARCH_PREVIEW_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${sliceOnCodePointBoundary(text, start, end)}${suffix}`;
}

function sliceOnCodePointBoundary(text: string, start: number, end: number): string {
  let safeStart = start;
  let safeEnd = end;
  if (
    safeStart > 0 &&
    safeStart < text.length &&
    isLowSurrogate(text.charCodeAt(safeStart))
  ) {
    safeStart += 1;
  }
  if (
    safeEnd > safeStart &&
    safeEnd < text.length &&
    isHighSurrogate(text.charCodeAt(safeEnd - 1))
  ) {
    safeEnd -= 1;
  }
  return text.slice(safeStart, safeEnd);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
