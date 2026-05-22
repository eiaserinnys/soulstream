const PLACEHOLDER_TEXT = new Set(["{}", "[]", "null", "undefined"]);

export function normalizeMeaningfulText(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (!text || PLACEHOLDER_TEXT.has(text)) return "";
  return /[\p{L}\p{N}]/u.test(text) ? text : "";
}

export function firstMeaningfulText(...values: unknown[]): string {
  for (const value of values) {
    const text = normalizeMeaningfulText(value);
    if (text) return text;
  }
  return "";
}
