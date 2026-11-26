import type {
  ClaudeAccountPool,
  ClaudeAccountUsage,
  ClaudeAccountUsageWindow,
} from "@soulstream/wire-schema";
import {
  effectiveWindowUsedPercent,
  isUsageExhaustedForScope,
  usageExhaustionResetMs,
} from "@soulstream/wire-schema/claude-account-usage";
import { isRecord } from "@soulstream/wire-schema/json-record";

export function emptyCentralUsage(): ClaudeAccountUsage {
  return { five_hour: null, seven_day: null, fable_weekly: null };
}

function normalizeResetIso(raw: unknown): string | null {
  if (typeof raw === "string" && raw.trim()) {
    const trimmed = raw.trim();
    const ms = Date.parse(trimmed);
    if (Number.isFinite(ms)) return trimmed;
    const num = Number(trimmed);
    if (Number.isFinite(num) && num > 0) {
      return new Date(num > 1e11 ? num : num * 1000).toISOString();
    }
    return null;
  }
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return new Date(raw > 1e11 ? raw : raw * 1000).toISOString();
  }
  return null;
}

function parseWindowNode(node: unknown): ClaudeAccountUsageWindow | null {
  if (!node || typeof node !== "object") return null;
  const obj = node as Record<string, unknown>;
  const rawPct =
    obj.utilization ??
    obj.percent ??
    obj.used_percent ??
    obj.usedPercent ??
    obj.percent_used ??
    obj.percentage;
  const numPct = typeof rawPct === "number" ? rawPct : Number(rawPct);
  if (!Number.isFinite(numPct)) return null;
  return {
    used_percent: Math.max(0, Math.min(100, numPct)),
    resets_at: normalizeResetIso(obj.resets_at ?? obj.reset_at ?? obj.resetsAt ?? obj.resetAt),
  };
}

function findScopedFableWindow(obj: Record<string, unknown>): ClaudeAccountUsageWindow | null {
  if (!Array.isArray(obj.limits)) return null;
  for (const item of obj.limits) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const scope = isRecord(entry.scope) ? entry.scope : null;
    const scopeModel = scope && isRecord(scope.model) ? scope.model : null;
    const directModel = isRecord(entry.model) ? entry.model : null;
    const label = String(
      scopeModel?.display_name ??
        scopeModel?.id ??
        directModel?.display_name ??
        directModel?.name ??
        directModel?.id ??
        entry.type ??
        entry.scope ??
        "",
    ).toLowerCase();
    if (label.includes("fable")) {
      const parsed = parseWindowNode(entry);
      if (parsed) return parsed;
    }
  }
  return null;
}

export function parseCentralUsagePayload(payload: unknown): ClaudeAccountUsage {
  if (!payload || typeof payload !== "object") return emptyCentralUsage();
  const obj = payload as Record<string, unknown>;
  return {
    five_hour: parseWindowNode(obj.five_hour ?? obj.fiveHour),
    seven_day: parseWindowNode(obj.seven_day ?? obj.sevenDay),
    fable_weekly:
      parseWindowNode(
        obj.seven_day_fable ?? obj.sevenDayFable ?? obj.fable_weekly ?? obj.fableWeekly,
      ) ?? findScopedFableWindow(obj),
  };
}

export type ClaudeCentralSummaryAccount = {
  readonly id: string;
  readonly enabled: boolean;
  readonly auth_state: "ok" | "needs_relogin";
  readonly usage: ClaudeAccountUsage;
};

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function accountAvailableForScope(
  account: ClaudeCentralSummaryAccount,
  scope: "all" | "fable",
  nowMs: number,
): boolean {
  if (!account.enabled) return false;
  if (account.auth_state !== "ok") return false;
  return !isUsageExhaustedForScope(account.usage, scope, nowMs);
}

function weeklyRemainingForScope(
  account: ClaudeCentralSummaryAccount,
  scope: "all" | "fable",
  nowMs: number,
): { remainingPercent: number; resetsAt: string | null } | null {
  if (account.auth_state !== "ok") return null;
  const candidates: Array<{ remaining: number; resetsAt: string | null }> = [];
  const sevenDay = account.usage.seven_day;
  const sevenUsed = effectiveWindowUsedPercent(sevenDay, nowMs);
  if (sevenUsed !== null && sevenDay) {
    candidates.push({ remaining: clampPercent(100 - sevenUsed), resetsAt: sevenDay.resets_at });
  }
  if (scope === "fable") {
    const fableWeekly = account.usage.fable_weekly;
    const fableUsed = effectiveWindowUsedPercent(fableWeekly, nowMs);
    if (fableUsed !== null && fableWeekly) {
      candidates.push({ remaining: clampPercent(100 - fableUsed), resetsAt: fableWeekly.resets_at });
    }
  }
  if (candidates.length === 0) return null;
  let bottleneck = candidates[0]!;
  for (const item of candidates.slice(1)) {
    if (item.remaining < bottleneck.remaining) bottleneck = item;
    else if (item.remaining === bottleneck.remaining && !bottleneck.resetsAt && item.resetsAt) {
      bottleneck = item;
    }
  }
  return {
    remainingPercent: bottleneck.remaining,
    resetsAt: bottleneck.resetsAt ?? account.usage.fable_weekly?.resets_at
      ?? account.usage.seven_day?.resets_at ?? null,
  };
}

function earliestAvailableAt(
  accounts: readonly ClaudeCentralSummaryAccount[],
  scope: "all" | "fable",
  nowMs: number,
): string | null {
  let earliestMs = Number.POSITIVE_INFINITY;
  let earliestIso: string | null = null;
  for (const account of accounts) {
    if (!account.enabled || account.auth_state !== "ok") continue;
    if (!isUsageExhaustedForScope(account.usage, scope, nowMs)) continue;
    const resetMs = usageExhaustionResetMs(account.usage, scope, nowMs);
    if (resetMs === null) continue;
    if (resetMs < earliestMs) {
      earliestMs = resetMs;
      earliestIso = new Date(resetMs).toISOString();
    }
  }
  return earliestIso;
}

export function computeCentralPoolSummary(
  accounts: readonly ClaudeCentralSummaryAccount[],
  scope: "all" | "fable",
  nowMs: number,
): ClaudeAccountPool {
  const enabledAccounts = accounts.filter((account) => account.enabled);
  const availableAccounts = enabledAccounts.filter((account) =>
    accountAvailableForScope(account, scope, nowMs));

  let best: { remainingPercent: number; resetsAt: string | null } | null = null;
  for (const account of accounts) {
    if (!accountAvailableForScope(account, scope, nowMs)) continue;
    const weekly = weeklyRemainingForScope(account, scope, nowMs);
    if (!weekly) continue;
    if (!best || weekly.remainingPercent > best.remainingPercent) best = weekly;
  }

  return {
    total_count: enabledAccounts.length,
    available_count: availableAccounts.length,
    best_weekly_remaining_percent: best ? best.remainingPercent : null,
    best_weekly_resets_at: best ? best.resetsAt : null,
    earliest_available_at: availableAccounts.length === 0
      ? earliestAvailableAt(accounts, scope, nowMs)
      : null,
  };
}
