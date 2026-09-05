/** Convert a wire-level tool result to lossless display text at the UI boundary. */
export function toolResultToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";

  try {
    const serialized = JSON.stringify(value, null, 2);
    return serialized ?? String(value);
  } catch {
    return String(value);
  }
}
