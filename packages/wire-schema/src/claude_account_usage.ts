import type {
  ClaudeAccountUsage,
  ClaudeAccountUsageWindow,
} from "../generated/typescript/index.js";

export function effectiveWindowUsedPercent(
  window: ClaudeAccountUsageWindow | null | undefined,
  nowMs: number,
): number | null {
  if (!window || typeof window.used_percent !== "number" || !Number.isFinite(window.used_percent)) {
    return null;
  }
  if (window.resets_at) {
    const resetMs = Date.parse(window.resets_at);
    if (Number.isFinite(resetMs) && resetMs <= nowMs) return 0;
  }
  return window.used_percent;
}

export function effectiveWindowResetMs(
  window: ClaudeAccountUsageWindow | null | undefined,
  nowMs: number,
): number | null {
  if (!window || typeof window.used_percent !== "number" || !Number.isFinite(window.used_percent)) {
    return null;
  }
  if (!window.resets_at) return null;
  const resetMs = Date.parse(window.resets_at);
  if (!Number.isFinite(resetMs) || resetMs <= nowMs) return null;
  return resetMs;
}

function exhaustedWindows(
  usage: ClaudeAccountUsage,
  scope: "all" | "fable",
  nowMs: number,
): ClaudeAccountUsageWindow[] {
  const windows: Array<ClaudeAccountUsageWindow | null> = [usage.five_hour, usage.seven_day];
  if (scope === "fable") windows.push(usage.fable_weekly);
  return windows.filter((window): window is ClaudeAccountUsageWindow =>
    window !== null && (effectiveWindowUsedPercent(window, nowMs) ?? 0) >= 100,
  );
}

export function isUsageExhaustedForScope(
  usage: ClaudeAccountUsage,
  scope: "all" | "fable",
  nowMs: number,
): boolean {
  return exhaustedWindows(usage, scope, nowMs).length > 0;
}

export function usageExhaustionResetMs(
  usage: ClaudeAccountUsage,
  scope: "all" | "fable",
  nowMs: number,
): number | null {
  const windows = exhaustedWindows(usage, scope, nowMs);
  if (windows.length === 0) return null;
  const resets = windows.map((window) => (window.resets_at ? Date.parse(window.resets_at) : NaN));
  return resets.every(Number.isFinite) ? Math.max(...resets) : null;
}
