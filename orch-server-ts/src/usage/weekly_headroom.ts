import type {
  UsageSummaryProvider,
  UsageSummaryQuota,
} from "./usage_summary_service.js";

const WEEK_SECONDS = 7 * 24 * 60 * 60;

export type WeeklyHeadroom = {
  readonly status: "ok" | "stale" | "unavailable";
  readonly headroom: number | null;
  readonly remaining_percent: number | null;
  readonly window_remaining_percent: number | null;
  readonly resets_at: string | null;
  readonly observed_at: string | null;
  readonly quota_label: string | null;
};

export type WeeklyHeadroomCalculation = {
  readonly headroom: number;
  readonly window_remaining_percent: number;
};

type Candidate = WeeklyHeadroomCalculation & {
  readonly remainingPercent: number;
  readonly resetAt: number;
  readonly quotaLabel: string;
  readonly selectionHeadroom: number;
};

export function computeWeeklyHeadroom(
  remainingPercent: number,
  resetAt: number,
  now: Date,
): WeeklyHeadroomCalculation {
  const windowRemainingPercent = getWindowRemainingPercent(resetAt, now);
  return {
    headroom: roundOneDecimal(remainingPercent - windowRemainingPercent),
    window_remaining_percent: roundOneDecimal(windowRemainingPercent),
  };
}

/** Resolve a provider's aggregate weekly window against preset-applicable quotas. */
export function resolveWeeklyHeadroom(
  provider: UsageSummaryProvider | null,
  applicableWeeklyQuotas: readonly UsageSummaryQuota[],
  stale: boolean,
  now: Date,
): WeeklyHeadroom {
  if (!provider || provider.status !== "auto") {
    return unavailableWeeklyHeadroom(provider?.observedAt ?? null);
  }

  const candidates: Candidate[] = [];
  if (
    provider.weeklyRemainingPercent !== null
    && provider.weeklyResetAt !== null
    && Number.isFinite(provider.weeklyRemainingPercent)
    && Number.isFinite(provider.weeklyResetAt)
  ) {
    candidates.push(makeCandidate(
      provider.weeklyRemainingPercent,
      provider.weeklyResetAt,
      "7일",
      now,
    ));
  }
  for (const quota of applicableWeeklyQuotas) {
    if (
      quota.remainingPercent === null
      || quota.resetAt === null
      || !Number.isFinite(quota.remainingPercent)
      || !Number.isFinite(quota.resetAt)
    ) continue;
    candidates.push(makeCandidate(
      quota.remainingPercent,
      quota.resetAt,
      quota.label.trim() || "7일",
      now,
    ));
  }

  const lowest = candidates.reduce<Candidate | null>(
    (selected, candidate) =>
      selected === null
      || candidate.selectionHeadroom < selected.selectionHeadroom
        ? candidate
        : selected,
    null,
  );
  if (!lowest) return unavailableWeeklyHeadroom(provider.observedAt ?? null);

  return {
    status: stale ? "stale" : "ok",
    headroom: lowest.headroom,
    remaining_percent: lowest.remainingPercent,
    window_remaining_percent: lowest.window_remaining_percent,
    resets_at: new Date(lowest.resetAt * 1_000).toISOString(),
    observed_at: provider.observedAt ?? null,
    quota_label: lowest.quotaLabel,
  };
}

function makeCandidate(
  remainingPercent: number,
  resetAt: number,
  quotaLabel: string,
  now: Date,
): Candidate {
  const windowRemainingPercent = getWindowRemainingPercent(resetAt, now);
  return {
    ...computeWeeklyHeadroom(remainingPercent, resetAt, now),
    remainingPercent,
    resetAt,
    quotaLabel,
    selectionHeadroom: remainingPercent - windowRemainingPercent,
  };
}

function getWindowRemainingPercent(resetAt: number, now: Date): number {
  const secondsUntilReset = resetAt - now.getTime() / 1_000;
  return 100 * Math.min(
    1,
    Math.max(0, secondsUntilReset / WEEK_SECONDS),
  );
}

function unavailableWeeklyHeadroom(observedAt: string | null): WeeklyHeadroom {
  return {
    status: "unavailable",
    headroom: null,
    remaining_percent: null,
    window_remaining_percent: null,
    resets_at: null,
    observed_at: observedAt,
    quota_label: null,
  };
}

function roundOneDecimal(value: number): number {
  return Number(value.toFixed(1));
}
