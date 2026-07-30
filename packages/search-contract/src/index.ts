const SEARCH_PREVIEW_RADIUS = 100;

export const SEARCH_EVENT_TYPES_BY_CATEGORY = {
  messages: ["user_message", "intervention_sent"],
  responses: ["assistant_message", "result", "complete"],
  thinking: ["thinking"],
  // The live TS persistence path stores tool events without searchable_text.
  // Keep the category in the client contract, but do not send dead event types.
  tools: [],
} as const;

export type SearchEventCategory = keyof typeof SEARCH_EVENT_TYPES_BY_CATEGORY;

export const DEFAULT_SEARCH_CATEGORIES = [
  "messages",
  "responses",
] as const satisfies readonly SearchEventCategory[];

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
