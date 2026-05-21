import type { ContextItem } from "@shared/types";

const FORMAT_KEY_INVALID_CHARS = /[^a-zA-Z0-9_]/g;
const ASCII_WORD_RE = /^[A-Za-z0-9_]+$/;

export interface ContextPromptTokenMetric {
  key: string;
  label?: string;
  tokens: number;
}

export interface ContextPromptTokenMetrics {
  totalTokens: number;
  items: ContextPromptTokenMetric[];
}

function serializeContextContent(content: unknown): string {
  if (content === undefined || content === null || content === "") return "";
  if (typeof content === "string") return content;
  if (typeof content === "object") return JSON.stringify(content, null, 2);
  return String(content);
}

function formatContextItemForPrompt(item: ContextItem): string {
  const serialized = serializeContextContent(item.content);
  if (!serialized) return "";
  const key = (item.key || "item").replace(FORMAT_KEY_INVALID_CHARS, "_") || "item";
  return `<${key}>\n${serialized}\n</${key}>`;
}

function formatContextItemsForPrompt(items: ContextItem[]): string {
  const parts = items
    .map((item) => formatContextItemForPrompt(item))
    .filter((part) => part.length > 0);
  if (parts.length === 0) return "";
  return `<context>\n${parts.join("\n")}\n</context>`;
}

function flushAsciiRun(run: string): number {
  if (!run) return 0;
  return Math.ceil(run.length / 4);
}

/**
 * Dashboard-only token estimate.
 *
 * Exact tokenizers differ by model and are not available in the browser bundle.
 * This keeps the count stable and honest enough for prompt budget triage:
 * ASCII word runs approximate BPE at 4 chars/token, CJK chars and punctuation
 * count as one token each.
 */
export function estimatePromptTokens(value: unknown): number {
  const text = typeof value === "string" ? value : serializeContextContent(value);
  const trimmed = text.trim();
  if (!trimmed) return 0;

  let tokens = 0;
  let asciiRun = "";
  for (const char of Array.from(trimmed)) {
    if (/\s/u.test(char)) {
      tokens += flushAsciiRun(asciiRun);
      asciiRun = "";
      continue;
    }
    if (ASCII_WORD_RE.test(char)) {
      asciiRun += char;
      continue;
    }
    tokens += flushAsciiRun(asciiRun);
    asciiRun = "";
    tokens += 1;
  }
  tokens += flushAsciiRun(asciiRun);
  return tokens;
}

export function buildContextPromptTokenMetrics(
  items: ContextItem[],
): ContextPromptTokenMetrics {
  return {
    totalTokens: estimatePromptTokens(formatContextItemsForPrompt(items)),
    items: items.map((item) => ({
      key: item.key,
      label: item.label,
      tokens: estimatePromptTokens(formatContextItemForPrompt(item)),
    })),
  };
}

export function formatPromptTokenCount(tokens: number): string {
  return `~${tokens.toLocaleString()} tokens`;
}

export function systemPromptTokenScope(backend?: string | null): "system" | "prompt" {
  return backend === "codex" ? "prompt" : "system";
}
