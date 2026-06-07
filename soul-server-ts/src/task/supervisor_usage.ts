export function usageTokenDelta(usage: unknown): number {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return 0;
  const record = usage as Record<string, unknown>;
  return (
    firstNumber(record, ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"]) +
    firstNumber(record, ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"]) +
    firstNumber(record, ["cache_creation_input_tokens", "cacheCreationInputTokens"]) +
    firstNumber(record, ["cache_read_input_tokens", "cacheReadInputTokens"])
  );
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.trunc(value);
    }
  }
  return 0;
}
