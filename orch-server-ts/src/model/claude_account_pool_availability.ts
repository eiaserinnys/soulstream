import type { ModelPresetAvailability } from "./model_preset_availability.js";
import type { ProviderLimitRejection } from "../usage/provider_limit_rejection.js";
import type { UsageSummaryClaudeAccount } from "../usage/provider_usage_wire.js";

type AvailabilityBase = Pick<
  ModelPresetAvailability,
  "id" | "label" | "backend" | "supported_efforts" | "default_effort" | "weekly_headroom"
>;

export type PoolAccountRejection = {
  readonly accountId: string;
  readonly scope: "all" | "fable";
  readonly rejection: ProviderLimitRejection;
};

export function resolveClaudePoolAvailability(
  base: AvailabilityBase,
  fablePreset: boolean,
  stale: boolean,
  accounts: readonly UsageSummaryClaudeAccount[],
  rejections: readonly PoolAccountRejection[],
  now: Date,
): ModelPresetAvailability {
  const candidates = accounts.filter((account) =>
    account.enabled && (
      stale || account.auth_state === "ok" || account.auth_state === "idle"
    ),
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

  const recoveries: string[] = [];
  let earliestReason: string | null = null;
  for (const account of candidates) {
    const activeBlocks: Array<{ until: string | null; rateLimitType: string | null }> = [];
    const accountBlock = !stale ? account.blocked : null;
    if (
      accountBlock !== null
      && (accountBlock.scope === "all" || fablePreset)
      && (accountBlock.until === null || isAfter(accountBlock.until, now))
    ) {
      activeBlocks.push({ until: accountBlock.until, rateLimitType: null });
    }
    for (const item of rejections) {
      if (item.accountId !== account.id || (item.scope === "fable" && !fablePreset)) continue;
      if (isLiveRejection(item.rejection, now)) {
        activeBlocks.push({
          until: item.rejection.rejectedUntil,
          rateLimitType: item.rejection.rateLimitType,
        });
      }
    }
    if (activeBlocks.length === 0) return availablePreset(base, stale);

    const indefinite = activeBlocks.some((block) => block.until === null);
    const accountReset = indefinite
      ? null
      : activeBlocks.reduce<string>((latest, block) =>
          Date.parse(block.until!) > Date.parse(latest) ? block.until! : latest,
        activeBlocks[0]!.until!);
    if (accountReset !== null) recoveries.push(accountReset);
    if (earliestReason === null) {
      earliestReason = activeBlocks.find((block) => block.rateLimitType !== null)?.rateLimitType ?? null;
    }
  }

  const earliestRecovery = recoveries
    .map((value) => ({ value, time: Date.parse(value) }))
    .filter((candidate) => Number.isFinite(candidate.time))
    .sort((left, right) => left.time - right.time)[0]?.value ?? null;
  return {
    ...base,
    available: false,
    reason: "limit_rejected",
    reason_label: rejectionReasonLabel(earliestReason),
    resets_at: earliestRecovery,
    usage_warning: false,
  };
}

export function rejectionReasonLabel(rateLimitType: string | null): string {
  if (rateLimitType === "five_hour") return "5시간 한도 거부 중";
  if (rateLimitType === "seven_day" || rateLimitType?.startsWith("seven_day_")) {
    return "7일 한도 거부 중";
  }
  return "한도 거부 중";
}

function isLiveRejection(rejection: ProviderLimitRejection, now: Date): boolean {
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
