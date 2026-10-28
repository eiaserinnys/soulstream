import type { ProviderLimits, ProviderQuota } from "../auth/provider_usage.js";
import {
  effectiveWindowUsedPercent,
  isBlockedForScope,
  isScopeBlockActive,
} from "./selector.js";
import type {
  ClaudeAccountBlocksRecord,
  ClaudeAccountList,
  ClaudeAccountPoolSummary,
  ClaudeAccountScope,
  ClaudeAccountView,
  ClaudeScopeBlockEntry,
} from "./types.js";

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, value));
}

function accountAvailableForScope(
  account: ClaudeAccountView,
  blocks: ClaudeAccountBlocksRecord | undefined,
  scope: ClaudeAccountScope,
  nowMs: number,
): boolean {
  if (!account.enabled) {
    return false;
  }
  if (account.auth_state !== "ok" && account.auth_state !== "idle") {
    return false;
  }
  return !isBlockedForScope(blocks, scope, nowMs);
}

function computeWeeklyRemainingForScope(
  account: ClaudeAccountView,
  scope: ClaudeAccountScope,
  nowMs: number,
): { remainingPercent: number; resetsAt: string | null } | null {
  if (account.stale || account.auth_state !== "ok") {
    return null;
  }

  const sevenDay = account.usage.seven_day;
  const fableWeekly = account.usage.fable_weekly;

  if (scope === "all") {
    const used = effectiveWindowUsedPercent(sevenDay, nowMs);
    if (used === null || !sevenDay) {
      return null;
    }
    return {
      remainingPercent: clampPercent(100 - used),
      resetsAt: sevenDay.resets_at,
    };
  }

  // scope === "fable": must pass both seven_day and fable_weekly when present
  const candidates: Array<{ remaining: number; resetsAt: string | null }> = [];
  const sevenUsed = effectiveWindowUsedPercent(sevenDay, nowMs);
  if (sevenUsed !== null && sevenDay) {
    candidates.push({
      remaining: clampPercent(100 - sevenUsed),
      resetsAt: sevenDay.resets_at,
    });
  }
  const fableUsed = effectiveWindowUsedPercent(fableWeekly, nowMs);
  if (fableUsed !== null && fableWeekly) {
    candidates.push({
      remaining: clampPercent(100 - fableUsed),
      resetsAt: fableWeekly.resets_at,
    });
  }

  if (candidates.length === 0) {
    return null;
  }

  // Bottleneck is the minimum remaining percent across applicable weekly windows
  let bottleneck = candidates[0]!;
  for (const item of candidates.slice(1)) {
    if (item.remaining < bottleneck.remaining) {
      bottleneck = item;
    } else if (item.remaining === bottleneck.remaining && !bottleneck.resetsAt && item.resetsAt) {
      bottleneck = item;
    }
  }

  return {
    remainingPercent: bottleneck.remaining,
    resetsAt: bottleneck.resetsAt ?? fableWeekly?.resets_at ?? sevenDay?.resets_at ?? null,
  };
}

function computeEarliestAvailableAt(
  accounts: ClaudeAccountView[],
  blocksByAccount: Record<string, ClaudeAccountBlocksRecord | undefined>,
  scope: ClaudeAccountScope,
  nowMs: number,
): string | null {
  let earliestMs = Number.POSITIVE_INFINITY;
  let earliestIso: string | null = null;

  for (const account of accounts) {
    if (!account.enabled) {
      continue;
    }
    if (account.auth_state !== "ok" && account.auth_state !== "idle") {
      continue;
    }
    const blocks = blocksByAccount[account.id];
    if (!isBlockedForScope(blocks, scope, nowMs)) {
      continue;
    }

    const activeEntries: ClaudeScopeBlockEntry[] = [];
    if (isScopeBlockActive(blocks?.all, nowMs) && blocks?.all) {
      activeEntries.push(blocks.all);
    }
    if (scope === "fable" && isScopeBlockActive(blocks?.fable, nowMs) && blocks?.fable) {
      activeEntries.push(blocks.fable);
    }

    if (activeEntries.length === 0) {
      continue;
    }

    // If any applicable active block has resets_at === null (indefinite), this account's unblock time is unknown
    let hasUnknownReset = false;
    let accountMaxMs = Number.NEGATIVE_INFINITY;
    let accountMaxIso: string | null = null;

    for (const entry of activeEntries) {
      if (entry.resets_at === null) {
        hasUnknownReset = true;
        break;
      }
      const parsedMs = Date.parse(entry.resets_at);
      if (!Number.isFinite(parsedMs)) {
        hasUnknownReset = true;
        break;
      }
      if (parsedMs > accountMaxMs) {
        accountMaxMs = parsedMs;
        accountMaxIso = entry.resets_at;
      }
    }

    if (hasUnknownReset || accountMaxIso === null) {
      continue;
    }

    if (accountMaxMs < earliestMs) {
      earliestMs = accountMaxMs;
      earliestIso = accountMaxIso;
    }
  }

  return earliestIso;
}

export function pickBestAccountForScope(
  accounts: ClaudeAccountView[],
  blocksByAccount: Record<string, ClaudeAccountBlocksRecord | undefined>,
  scope: ClaudeAccountScope,
  nowMs: number,
): {
  account: ClaudeAccountView;
  remainingPercent: number;
  resetsAt: string | null;
} | null {
  let best: {
    account: ClaudeAccountView;
    remainingPercent: number;
    resetsAt: string | null;
  } | null = null;

  for (const account of accounts) {
    if (!accountAvailableForScope(account, blocksByAccount[account.id], scope, nowMs)) {
      continue;
    }
    const weekly = computeWeeklyRemainingForScope(account, scope, nowMs);
    if (!weekly) {
      continue;
    }
    if (!best || weekly.remainingPercent > best.remainingPercent) {
      best = {
        account,
        remainingPercent: weekly.remainingPercent,
        resetsAt: weekly.resetsAt,
      };
    }
  }

  return best;
}

export function computePoolSummary(
  accounts: ClaudeAccountView[],
  blocksByAccount: Record<string, ClaudeAccountBlocksRecord | undefined>,
  scope: ClaudeAccountScope,
  nowMs: number,
): ClaudeAccountPoolSummary {
  const enabledAccounts = accounts.filter((acc) => acc.enabled);
  const total_count = enabledAccounts.length;

  const availableAccounts = enabledAccounts.filter((acc) =>
    accountAvailableForScope(acc, blocksByAccount[acc.id], scope, nowMs),
  );
  const available_count = availableAccounts.length;

  const best = pickBestAccountForScope(accounts, blocksByAccount, scope, nowMs);

  const earliest_available_at =
    available_count === 0
      ? computeEarliestAvailableAt(accounts, blocksByAccount, scope, nowMs)
      : null;

  return {
    total_count,
    available_count,
    best_weekly_remaining_percent: best ? best.remainingPercent : null,
    best_weekly_resets_at: best ? best.resetsAt : null,
    earliest_available_at,
  };
}

function isoToEpochSeconds(iso: string | null | undefined): number | null {
  if (!iso) {
    return null;
  }
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    return null;
  }
  return Math.floor(ms / 1000);
}

export function claudeLimitsFromAccountPool(params: {
  accountList: ClaudeAccountList;
  bestGeneralAccount: ClaudeAccountView | null;
  bestFableAccount: ClaudeAccountView | null;
  source?: string;
}): ProviderLimits {
  const { accountList, bestGeneralAccount, bestFableAccount } = params;
  const source = params.source ?? "https://api.anthropic.com/api/oauth/usage";
  const quotas: ProviderQuota[] = [];

  let shortUsedPercent: number | null = null;
  let shortWindowMinutes: number | null = null;
  let shortResetAt: number | null = null;
  let weeklyUsedPercent: number | null = null;
  let weeklyResetAt: number | null = null;

  if (bestGeneralAccount?.usage.five_hour) {
    const fiveHour = bestGeneralAccount.usage.five_hour;
    const usedPct = clampPercent(fiveHour.used_percent);
    const resetEpoch = isoToEpochSeconds(fiveHour.resets_at);
    shortUsedPercent = usedPct;
    shortWindowMinutes = 300;
    shortResetAt = resetEpoch;
    quotas.push({
      id: "claude:five_hour",
      label: "5시간",
      window: "5h",
      unit: null,
      used: null,
      remaining: null,
      limit: null,
      usedPercent: usedPct,
      remainingPercent: clampPercent(100 - usedPct),
      resetAt: resetEpoch,
      model: null,
      source,
    });
  }

  if (bestGeneralAccount?.usage.seven_day) {
    const sevenDay = bestGeneralAccount.usage.seven_day;
    const usedPct = clampPercent(sevenDay.used_percent);
    const resetEpoch = isoToEpochSeconds(sevenDay.resets_at);
    weeklyUsedPercent = usedPct;
    weeklyResetAt = resetEpoch;
    quotas.push({
      id: "claude:seven_day",
      label: "7일",
      window: "7d",
      unit: null,
      used: null,
      remaining: null,
      limit: null,
      usedPercent: usedPct,
      remainingPercent: clampPercent(100 - usedPct),
      resetAt: resetEpoch,
      model: null,
      source,
    });
  }

  if (bestFableAccount?.usage.fable_weekly) {
    const fableWeekly = bestFableAccount.usage.fable_weekly;
    const usedPct = clampPercent(fableWeekly.used_percent);
    const resetEpoch = isoToEpochSeconds(fableWeekly.resets_at);
    quotas.push({
      id: "claude:weekly_scoped:fable",
      label: "Fable",
      window: "7d",
      unit: null,
      used: null,
      remaining: null,
      limit: null,
      usedPercent: usedPct,
      remainingPercent: clampPercent(100 - usedPct),
      resetAt: resetEpoch,
      model: "fable",
      source,
    });
  }

  const observedAt =
    bestGeneralAccount?.observed_at ??
    bestFableAccount?.observed_at ??
    accountList.accounts.find((acc) => acc.observed_at !== null)?.observed_at ??
    null;

  const planType =
    bestGeneralAccount?.plan ??
    bestFableAccount?.plan ??
    accountList.accounts[0]?.plan ??
    null;

  return {
    status: accountList.accounts.length > 0 ? "auto" : "not_configured",
    source: accountList.accounts.length > 0 ? source : "none",
    sourceKind: accountList.accounts.length > 0 ? "remote" : undefined,
    observedAt,
    weeklyTokens: null,
    monthlyTokens: null,
    sessionTokens: null,
    weeklyUsedPercent,
    weeklyResetAt,
    shortUsedPercent,
    shortWindowMinutes,
    shortResetAt,
    planType,
    quotas,
    mode: "pool",
    accounts: accountList.accounts,
    pool: accountList.pool,
    fable_pool: accountList.fable_pool,
  };
}
