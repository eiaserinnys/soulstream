export type ContextUsagePayload = {
  type: "context_usage";
  used_tokens: number;
  max_tokens: number;
  percent: number;
};

export function contextUsagePercent(used: number, max: number): number | undefined {
  if (!Number.isFinite(used) || used <= 0 || !Number.isFinite(max) || max <= 0) {
    return undefined;
  }
  return Math.round((used / max) * 1000) / 10;
}

export function makeContextUsagePayload(
  used: unknown,
  max: unknown,
): ContextUsagePayload | undefined {
  if (typeof used !== "number" || typeof max !== "number") return undefined;
  const percent = contextUsagePercent(used, max);
  if (percent === undefined) return undefined;
  return {
    type: "context_usage",
    used_tokens: used,
    max_tokens: max,
    percent,
  };
}
