import type { NormalizedChatUiDocumentV1 } from "./types.js";

function canonicalValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function canonicalJson(doc: NormalizedChatUiDocumentV1): string {
  return canonicalValue(doc);
}
