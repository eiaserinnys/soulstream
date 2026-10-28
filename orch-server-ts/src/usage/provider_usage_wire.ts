import type { UsageSummaryProviderName } from "./usage_summary_service.js";

export type UsageSummaryClaudeAccount = {
  readonly id: string;
  readonly email: string;
  readonly plan: string | null;
  readonly enabled: boolean;
  readonly priority: number | null;
  readonly auth_state: "ok" | "idle" | "needs_relogin" | "logging_in";
  readonly usage: {
    readonly five_hour: unknown;
    readonly seven_day: unknown;
    readonly fable_weekly: unknown;
  };
  readonly observed_at: string | null;
  readonly blocked: { readonly until: string | null; readonly scope: "all" | "fable" } | null;
  readonly active_sessions: number;
};

export type UsageSummaryClaudeAccountPool = {
  readonly available_count: number;
  readonly total_count: number;
  readonly best_weekly_remaining_percent: number | null;
  readonly best_weekly_resets_at: string | null;
  readonly earliest_available_at: string | null;
};

export type ProviderQuota = {
  readonly id: string;
  readonly label: string;
  readonly window: string | null;
  readonly model: string | null;
  readonly remainingPercent: number | null;
  readonly resetAt: number | null;
  readonly source?: string | null;
  readonly purpose?: "execution" | "code_review" | "other";
};

export type ProviderLimits = {
  readonly status: "auto" | "not_configured" | "error";
  readonly source?: string | null;
  readonly sourceKind?: "remote" | "rollout" | "unknown";
  readonly observedAt?: string | null;
  readonly weeklyUsedPercent: number | null;
  readonly weeklyResetAt: number | null;
  readonly shortUsedPercent: number | null;
  readonly shortResetAt: number | null;
  readonly quotas: readonly ProviderQuota[];
  readonly mode?: "legacy" | "pool";
  readonly accounts?: readonly UsageSummaryClaudeAccount[];
  readonly pool?: UsageSummaryClaudeAccountPool | null;
  readonly fable_pool?: UsageSummaryClaudeAccountPool | null;
};

export type ProviderUsageSnapshot = {
  readonly providers: Readonly<Record<UsageSummaryProviderName, ProviderLimits>>;
};

export const NOT_CONFIGURED_PROVIDER_LIMITS: ProviderLimits = {
  status: "not_configured",
  weeklyUsedPercent: null,
  weeklyResetAt: null,
  shortUsedPercent: null,
  shortResetAt: null,
  quotas: [],
};

export function parseProviderUsageSnapshot(value: unknown): ProviderUsageSnapshot {
  const record = requiredRecord(value, "provider usage snapshot");
  const providers = requiredRecord(record.providers, "provider usage providers");
  return {
    providers: {
      claude: parseProviderLimits(providers.claude, "claude"),
      codex: parseProviderLimits(providers.codex, "codex"),
      antigravity: providers.antigravity === undefined
        ? NOT_CONFIGURED_PROVIDER_LIMITS
        : parseProviderLimits(providers.antigravity, "antigravity"),
    },
  };
}

export function parseProviderLimits(value: unknown, provider: string): ProviderLimits {
  const record = requiredRecord(value, `${provider} limits`);
  const status = record.status;
  if (status !== "auto" && status !== "not_configured" && status !== "error") {
    throw new Error(`${provider} limits status is invalid`);
  }
  if (!Array.isArray(record.quotas)) throw new Error(`${provider} limits quotas must be an array`);
  return {
    status,
    source: typeof record.source === "string" ? record.source : null,
    sourceKind: record.sourceKind === "remote" || record.sourceKind === "rollout"
      ? record.sourceKind : "unknown",
    observedAt: typeof record.observedAt === "string" ? record.observedAt : null,
    weeklyUsedPercent: nullableNumber(record.weeklyUsedPercent, `${provider}.weeklyUsedPercent`),
    weeklyResetAt: nullableNumber(record.weeklyResetAt, `${provider}.weeklyResetAt`),
    shortUsedPercent: nullableNumber(record.shortUsedPercent, `${provider}.shortUsedPercent`),
    shortResetAt: nullableNumber(record.shortResetAt, `${provider}.shortResetAt`),
    quotas: record.quotas.map((quota, index) => parseQuota(quota, provider, index)),
    ...(provider === "claude" ? parseClaudeAccountFields(record) : {}),
  };
}

function parseClaudeAccountFields(record: Record<string, unknown>): Pick<
  ProviderLimits,
  "mode" | "accounts" | "pool" | "fable_pool"
> | Record<string, never> {
  const keys = ["mode", "accounts", "pool", "fable_pool"] as const;
  if (!keys.some((key) => Object.hasOwn(record, key))) return {};
  if (record.mode !== "legacy" && record.mode !== "pool") {
    throw new Error("claude account pool mode is invalid");
  }
  if (!Array.isArray(record.accounts)) throw new Error("claude accounts must be an array");
  return {
    mode: record.mode,
    accounts: record.accounts.map(parseClaudeAccount),
    pool: parseAccountPool(record.pool, "claude pool"),
    fable_pool: parseAccountPool(record.fable_pool, "claude fable_pool"),
  };
}

function parseClaudeAccount(value: unknown): UsageSummaryClaudeAccount {
  const record = requiredRecord(value, "claude account");
  if (typeof record.enabled !== "boolean") throw new Error("claude account enabled must be a boolean");
  if (
    record.auth_state !== "ok" && record.auth_state !== "idle"
    && record.auth_state !== "needs_relogin" && record.auth_state !== "logging_in"
  ) throw new Error("claude account auth_state is invalid");
  if (record.blocked !== null) {
    const blocked = requiredRecord(record.blocked, "claude account blocked");
    if (blocked.scope !== "all" && blocked.scope !== "fable") {
      throw new Error("claude account blocked scope is invalid");
    }
    if (blocked.until !== null && typeof blocked.until !== "string") {
      throw new Error("claude account blocked until is invalid");
    }
  }
  return record as unknown as UsageSummaryClaudeAccount;
}

function parseAccountPool(
  value: unknown,
  label: string,
): UsageSummaryClaudeAccountPool | null {
  if (value === null) return null;
  const record = requiredRecord(value, label);
  return {
    available_count: requiredNumber(record.available_count, `${label}.available_count`),
    total_count: requiredNumber(record.total_count, `${label}.total_count`),
    best_weekly_remaining_percent: nullableNumber(
      record.best_weekly_remaining_percent,
      `${label}.best_weekly_remaining_percent`,
    ),
    best_weekly_resets_at: nullableString(record.best_weekly_resets_at, `${label}.best_weekly_resets_at`),
    earliest_available_at: nullableString(record.earliest_available_at, `${label}.earliest_available_at`),
  };
}

function parseQuota(value: unknown, provider: string, index: number): ProviderQuota {
  const record = requiredRecord(value, `${provider}.quotas[${index}]`);
  return {
    source: typeof record.source === "string" ? record.source : null,
    purpose: record.purpose === "execution" || record.purpose === "code_review"
      ? record.purpose : "other",
    id: requiredString(record.id, `${provider}.quotas[${index}].id`),
    label: requiredString(record.label, `${provider}.quotas[${index}].label`),
    window: nullableString(record.window, `${provider}.quotas[${index}].window`),
    model: nullableString(record.model, `${provider}.quotas[${index}].model`),
    remainingPercent: nullableNumber(
      record.remainingPercent,
      `${provider}.quotas[${index}].remainingPercent`,
    ),
    resetAt: nullableNumber(record.resetAt, `${provider}.quotas[${index}].resetAt`),
  };
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a string`);
  return value;
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`${label} must be a string or null`);
  return value;
}

function nullableNumber(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number or null`);
  }
  return value;
}
