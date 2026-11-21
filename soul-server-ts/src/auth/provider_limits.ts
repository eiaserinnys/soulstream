import type { ClaudeAccountPool } from "@soulstream/wire-schema";
import type { ClaudeAccountView } from "../claude_accounts/index.js";

export interface ProviderQuota {
  id: string;
  label: string;
  window: string | null;
  unit: string | null;
  used: number | null;
  remaining: number | null;
  limit: number | null;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetAt: number | null;
  model: string | null;
  source: string | null;
  purpose?: "execution" | "code_review" | "other";
}

export interface ProviderLimits {
  status: "auto" | "not_configured" | "error";
  source: string;
  sourceKind?: "remote" | "rollout" | "unknown";
  observedAt?: string | null;
  weeklyTokens: number | null;
  monthlyTokens: number | null;
  sessionTokens: number | null;
  weeklyUsedPercent: number | null;
  weeklyResetAt: number | null;
  shortUsedPercent: number | null;
  shortWindowMinutes: number | null;
  shortResetAt: number | null;
  planType: string | null;
  quotas: ProviderQuota[];
  error?: string;
  mode?: "pool" | "legacy";
  accounts?: ClaudeAccountView[];
  pool?: ClaudeAccountPool;
  fable_pool?: ClaudeAccountPool | null;
}

export function emptyLimits(
  status: ProviderLimits["status"] = "not_configured",
  error?: string,
): ProviderLimits {
  return {
    status,
    source: "",
    sourceKind: "unknown",
    observedAt: null,
    weeklyTokens: null,
    monthlyTokens: null,
    sessionTokens: null,
    weeklyUsedPercent: null,
    weeklyResetAt: null,
    shortUsedPercent: null,
    shortWindowMinutes: null,
    shortResetAt: null,
    planType: null,
    quotas: [],
    ...(error ? { error } : {}),
  };
}
