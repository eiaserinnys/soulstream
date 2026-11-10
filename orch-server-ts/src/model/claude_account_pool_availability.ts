import type { ModelPresetAvailability } from "./model_preset_availability.js";
import type { ProviderLimitRejection } from "../usage/provider_limit_rejection.js";
import type {
  UsageSummaryClaudeAccount,
  UsageSummaryClaudeAccountPool,
} from "../usage/provider_usage_wire.js";
import type { ClaudePoolAvailabilityAccount } from "../usage/claude_account_pool_observation.js";

type AvailabilityBase = Pick<
  ModelPresetAvailability,
  "id" | "label" | "backend" | "supported_efforts" | "default_effort" | "weekly_headroom"
>;

export type PoolAccountRejection = {
  readonly accountId: string;
  readonly scope: "all" | "fable";
  readonly rejection: Pick<ProviderLimitRejection, "rejectedUntil" | "rateLimitType">;
};

export type ModelPresetPoolAccount = {
  readonly id: string;
  readonly email: string;
  readonly plan: string | null;
  readonly enabled: boolean;
  readonly auth_state: UsageSummaryClaudeAccount["auth_state"];
  readonly active_sessions: number;
  readonly remaining_percent: number | null;
  readonly resets_at: string | null;
  readonly blocked: boolean;
  readonly blocked_until: string | null;
};

export type ModelPresetAccountPool = {
  readonly available_count: number | null;
  readonly total_count: number;
  readonly accounts: readonly ModelPresetPoolAccount[];
};

export function resolveClaudePoolAvailability(
  base: AvailabilityBase,
  fablePreset: boolean,
  stale: boolean,
  accounts: readonly UsageSummaryClaudeAccount[],
  pool: UsageSummaryClaudeAccountPool | null | undefined,
  rejections: readonly PoolAccountRejection[],
  now: Date,
): ModelPresetAvailability {
  const candidates = accounts.filter((account) =>
    account.enabled && (account.auth_state === "ok" || account.auth_state === "idle"),
  );
  if (candidates.length === 0) {
    return {
      ...base,
      available: false,
      reason: "not_authenticated",
      reason_label: "미인증",
      resets_at: null,
      usage_warning: stale,
    };
  }

  const memoryBlocks = candidates.map((account) => ({
    blocks: rejections.filter((item) =>
      item.accountId === account.id
      && (item.scope === "all" || fablePreset)
      && isLiveRejection(item.rejection, now),
    ),
  }));
  if (memoryBlocks.every(({ blocks }) => blocks.length > 0)) {
    const rejected = rejectedPreset(base, stale, memoryBlocks.flatMap(({ blocks }) => blocks), now);
    if (pool !== null && pool !== undefined && pool.total_count > 0 && pool.available_count === 0) {
      return {
        ...rejected,
        resets_at: laterReset(pool.earliest_available_at, rejected.resets_at),
      };
    }
    return rejected;
  }

  const poolAvailable = pool !== null && pool !== undefined && (
    pool.available_count > 0
    || (pool.earliest_available_at !== null && !isAfter(pool.earliest_available_at, now))
  );
  if (poolAvailable === true) return availablePreset(base, stale || candidates.every((account) => account.auth_state === "idle"));

  if (pool !== null && pool !== undefined && pool.total_count > 0 && pool.available_count === 0) {
    return {
      ...base,
      available: false,
      reason: "limit_rejected",
      reason_label: rejectionReasonLabel(null),
      resets_at: pool.earliest_available_at,
      usage_warning: stale,
    };
  }

  if (pool === null || pool === undefined) {
    return availablePreset(base, true);
  }
  return {
    ...base,
    available: false,
    reason: "not_authenticated",
    reason_label: "미인증",
    resets_at: null,
    usage_warning: stale,
  };
}

/** Display-only per-account pool state for model preset listings. */
export function buildAccountPool(
  accounts: readonly ClaudePoolAvailabilityAccount[],
  pool: UsageSummaryClaudeAccountPool | null | undefined,
  rejections: readonly PoolAccountRejection[],
  fablePreset: boolean,
  now: Date,
): ModelPresetAccountPool {
  return {
    available_count: pool === null || pool === undefined ? null : pool.available_count,
    total_count: pool === null || pool === undefined ? accounts.length : pool.total_count,
    accounts: accounts.map((account) => {
      const usage = usageWindow(fablePreset ? account.usage.fable_weekly : account.usage.seven_day);
      const block = account.blocked !== null
        && (account.blocked.scope === "all" || fablePreset)
        ? account.blocked
        : null;
      const liveRejections = rejections.filter((item) =>
        item.accountId === account.id
        && (item.scope === "all" || fablePreset)
        && isLiveRejection(item.rejection, now),
      );
      const ends = [
        ...(block === null ? [] : [block.until]),
        ...liveRejections.map((item) => item.rejection.rejectedUntil),
      ];
      const blocked = block !== null || liveRejections.length > 0;
      return {
        id: account.id,
        email: account.email,
        plan: account.plan,
        enabled: account.enabled,
        auth_state: account.auth_state,
        active_sessions: account.active_sessions,
        remaining_percent: usage?.remainingPercent ?? null,
        resets_at: usage?.resetsAt ?? null,
        blocked,
        blocked_until: !blocked || ends.some((end) => end === null)
          ? null
          : latestEnd(ends),
      };
    }),
  };
}

function usageWindow(
  value: unknown,
): { remainingPercent: number; resetsAt: string | null } | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as { used_percent?: unknown; resets_at?: unknown };
  if (typeof record.used_percent !== "number" || !Number.isFinite(record.used_percent)) {
    return null;
  }
  return {
    remainingPercent: Math.max(0, Math.min(100, 100 - record.used_percent)),
    resetsAt: typeof record.resets_at === "string" ? record.resets_at : null,
  };
}

function latestEnd(ends: readonly (string | null)[]): string | null {
  return ends.reduce<string | null>((latest, end) => {
    if (end === null) return latest;
    if (latest === null) return end;
    return Date.parse(end) > Date.parse(latest) ? end : latest;
  }, null);
}

function rejectedPreset(
  base: AvailabilityBase,
  stale: boolean,
  rejections: readonly PoolAccountRejection[],
  now: Date,
): ModelPresetAvailability {
  const accountIds = [...new Set(rejections.map((item) => item.accountId))];
  const accountRecoveries = accountIds.map((accountId) => {
    const accountRejections = rejections.filter((item) => item.accountId === accountId);
    if (accountRejections.some((item) => item.rejection.rejectedUntil === null)) return null;
    return accountRejections.reduce<string | null>((latest, item) => {
      const reset = item.rejection.rejectedUntil;
      if (reset === null) return latest;
      return latest === null || Date.parse(reset) > Date.parse(latest) ? reset : latest;
    }, null);
  });
  const finiteRecoveries = accountRecoveries
    .filter((value): value is string => value !== null && isAfter(value, now))
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  const reason = rejections.find((item) => item.rejection.rateLimitType !== null)?.rejection.rateLimitType ?? null;
  return {
    ...base,
    available: false,
    reason: "limit_rejected",
    reason_label: rejectionReasonLabel(reason),
    resets_at: finiteRecoveries[0] ?? null,
    usage_warning: stale,
  };
}

function laterReset(sourceReset: string | null, memoryReset: string | null): string | null {
  if (sourceReset === null || memoryReset === null) return null;
  const sourceTime = Date.parse(sourceReset);
  const memoryTime = Date.parse(memoryReset);
  if (!Number.isFinite(sourceTime)) return memoryReset;
  if (!Number.isFinite(memoryTime)) return sourceReset;
  return sourceTime >= memoryTime ? sourceReset : memoryReset;
}

export function rejectionReasonLabel(rateLimitType: string | null): string {
  if (rateLimitType === "five_hour") return "5시간 한도 거부 중";
  if (rateLimitType === "seven_day" || rateLimitType?.startsWith("seven_day_")) {
    return "7일 한도 거부 중";
  }
  return "한도 거부 중";
}

function isLiveRejection(
  rejection: Pick<ProviderLimitRejection, "rejectedUntil">,
  now: Date,
): boolean {
  return rejection.rejectedUntil === null || isAfter(rejection.rejectedUntil, now);
}

function isAfter(value: string, now: Date): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > now.getTime();
}

function availablePreset(preset: AvailabilityBase, usageWarning: boolean): ModelPresetAvailability {
  return {
    ...preset,
    available: true,
    reason: null,
    reason_label: null,
    resets_at: null,
    usage_warning: usageWarning,
  };
}
