import {
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
} from "@anthropic-ai/claude-agent-sdk";

const COMPACT_SYSTEM_REMINDER_HEADER = [
  "Conversation compaction just occurred.",
  "The following system instructions remain authoritative. Continue following them exactly.",
  "Use them as instructions only; do not quote this reminder to the user.",
].join(" ");

export function compactMessage(trigger: string): string {
  return `Claude session compacted (${trigger})`;
}

export function makeCacheableSystemPrompt(systemPrompt: string | string[]): string[] {
  // Prompt caching lowers cost/latency, but the prompt still counts in the request context.
  if (Array.isArray(systemPrompt)) {
    if (systemPrompt.includes(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)) return systemPrompt;
    return [...systemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY];
  }
  return [systemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY];
}

export function makeCompactSystemReminder(systemPrompt: string[] | undefined): string | undefined {
  const promptBlocks = systemPrompt
    ?.filter((block) => block !== SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
  if (!promptBlocks || promptBlocks.length === 0) return undefined;
  return `${COMPACT_SYSTEM_REMINDER_HEADER}\n\n<system_prompt>\n${promptBlocks.join("\n\n")}\n</system_prompt>`;
}
