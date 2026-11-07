import type { ProviderLimits, ProviderQuota } from "./provider_usage.js";

/** OpenCode Go subscription usage endpoint (measured 261107). */
export const OPENCODE_GO_USAGE_URL = "https://opencode.ai/inference/go/v1/usage";

export interface OpencodeGoUsageConfig {
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

interface UsageWindow {
  key: string;
  id: string;
  label: string;
  window: string;
}

const USAGE_WINDOWS: readonly UsageWindow[] = [
  { key: "rolling", id: "opencode_go:rolling", label: "5시간", window: "5h" },
  { key: "weekly", id: "opencode_go:weekly", label: "7일", window: "7d" },
  { key: "monthly", id: "opencode_go:monthly", label: "월", window: "monthly" },
];

/**
 * Reads the Go subscription quota for the account behind the API key, nothing
 * else. Without a key it stays `not_configured` and never touches the network.
 * Failure messages carry the status or a fixed label — never the key.
 */
export async function collectOpencodeGoUsage(
  config: OpencodeGoUsageConfig | undefined,
  signal: AbortSignal,
): Promise<ProviderLimits> {
  const apiKey = config?.apiKey;
  if (!apiKey) return blankLimits("not_configured");
  const fetchImpl = config?.fetchImpl ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(OPENCODE_GO_USAGE_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal,
    });
  } catch {
    return blankLimits("error", "OpenCode Go usage request failed");
  }
  if (response.status === 401) return blankLimits("error", "OpenCode Go 키 오류");
  if (response.status === 403) return blankLimits("error", "OpenCode Go 구독 없음");
  if (!response.ok) {
    return blankLimits("error", `OpenCode Go usage HTTP ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return blankLimits("error", "Invalid OpenCode Go usage response");
  }
  return limitsFromResponse(body);
}

function limitsFromResponse(body: unknown): ProviderLimits {
  let quotas: ProviderQuota[];
  try {
    const usage = readUsage(body);
    quotas = USAGE_WINDOWS.map((entry) => quotaFromWindow(usage[entry.key], entry));
  } catch {
    return blankLimits("error", "Invalid OpenCode Go usage response");
  }
  const weekly = quotas.find((quota) => quota.window === "7d");
  const short = quotas.find((quota) => quota.window === "5h");
  return {
    ...blankLimits("auto"),
    source: OPENCODE_GO_USAGE_URL,
    sourceKind: "remote",
    observedAt: new Date().toISOString(),
    planType: "구독",
    weeklyUsedPercent: weekly?.usedPercent ?? null,
    weeklyResetAt: weekly?.resetAt ?? null,
    shortUsedPercent: short?.usedPercent ?? null,
    shortResetAt: short?.resetAt ?? null,
    shortWindowMinutes: 300,
    quotas,
  };
}

function readUsage(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null) throw new Error("missing usage");
  const usage = (body as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) throw new Error("missing usage");
  return usage as Record<string, unknown>;
}

function quotaFromWindow(value: unknown, entry: UsageWindow): ProviderQuota {
  if (typeof value !== "object" || value === null) throw new Error("missing window");
  const window = value as { status?: unknown; percent?: unknown; resetsAt?: unknown };
  if (window.status !== "ok" && window.status !== "rate-limited") {
    throw new Error("invalid status");
  }
  const percent = window.percent;
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0) {
    throw new Error("invalid percent");
  }
  const resetMs = typeof window.resetsAt === "string" ? Date.parse(window.resetsAt) : Number.NaN;
  if (!Number.isFinite(resetMs)) throw new Error("invalid reset");
  // `percent` is the used ratio; a throttled window is fully spent regardless
  // of the number the endpoint reports.
  const usedPercent = window.status === "rate-limited" ? 100 : Math.min(100, percent);
  return {
    id: entry.id,
    label: entry.label,
    window: entry.window,
    unit: null,
    used: null,
    remaining: null,
    limit: null,
    model: null,
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetAt: resetMs / 1000,
    source: OPENCODE_GO_USAGE_URL,
    purpose: "execution",
  };
}

function blankLimits(status: ProviderLimits["status"], error?: string): ProviderLimits {
  return {
    status, source: "", sourceKind: "unknown", observedAt: null,
    weeklyTokens: null, monthlyTokens: null, sessionTokens: null,
    weeklyUsedPercent: null, weeklyResetAt: null, shortUsedPercent: null,
    shortWindowMinutes: null, shortResetAt: null, planType: null, quotas: [],
    ...(error ? { error } : {}),
  };
}
