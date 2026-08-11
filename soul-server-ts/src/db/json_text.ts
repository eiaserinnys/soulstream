export function truncateJsonText(value: string, maxCodePoints: number): string {
  return Array.from(sanitizeJsonText(value)).slice(0, maxCodePoints).join("");
}

export function sanitizeJsonValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeJsonText(value);
  if (Array.isArray(value)) {
    return value.map((item) => item === undefined ? null : sanitizeJsonValue(item));
  }
  if (!value || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    result[key] = sanitizeJsonValue(item);
  }
  return result;
}

export function sanitizeJsonText(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0) continue;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value[index] ?? "";
        result += value[index + 1] ?? "";
        index += 1;
      } else {
        result += "\uFFFD";
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      result += "\uFFFD";
      continue;
    }
    result += value[index] ?? "";
  }
  return result;
}
