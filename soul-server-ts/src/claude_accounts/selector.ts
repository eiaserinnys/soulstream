import type {
  ClaudeAccountAuthState,
  ClaudeAccountBlocksRecord,
  ClaudeAccountBlockView,
  ClaudeAccountUsage,
  ClaudeScopeBlockEntry,
  ClaudeUsageWindow,
} from "./types.js";

export const SOFT_USAGE_CAP_PERCENT = 98;

export function isFableModel(model: string | null | undefined): boolean {
  return typeof model === "string" && model.toLowerCase().includes("fable");
}

export function isScopeBlockActive(
  entry: ClaudeScopeBlockEntry | undefined,
  nowMs: number,
): boolean {
  if (!entry) {
    return false;
  }
  if (entry.resets_at === null) {
    return true;
  }
  const resetMs = Date.parse(entry.resets_at);
  if (!Number.isFinite(resetMs)) {
    return true;
  }
  return resetMs > nowMs;
}

export function isBlockedForScope(
  blocks: ClaudeAccountBlocksRecord | undefined,
  targetScope: "all" | "fable",
  nowMs: number,
): boolean {
  if (!blocks) {
    return false;
  }
  if (isScopeBlockActive(blocks.all, nowMs)) {
    return true;
  }
  if (targetScope === "fable" && isScopeBlockActive(blocks.fable, nowMs)) {
    return true;
  }
  return false;
}

export function isBlockedForModel(
  blocks: ClaudeAccountBlocksRecord | undefined,
  model: string,
  nowMs: number,
): boolean {
  return isBlockedForScope(blocks, isFableModel(model) ? "fable" : "all", nowMs);
}

export function projectPublicBlockView(
  blocks: ClaudeAccountBlocksRecord | undefined,
  nowMs: number,
): ClaudeAccountBlockView | null {
  if (!blocks) {
    return null;
  }
  if (isScopeBlockActive(blocks.all, nowMs)) {
    return {
      until: blocks.all!.resets_at,
      scope: "all",
    };
  }
  if (isScopeBlockActive(blocks.fable, nowMs)) {
    return {
      until: blocks.fable!.resets_at,
      scope: "fable",
    };
  }
  return null;
}

export function effectiveWindowUsedPercent(
  window: ClaudeUsageWindow | null | undefined,
  nowMs: number,
): number | null {
  if (!window || typeof window.used_percent !== "number" || !Number.isFinite(window.used_percent)) {
    return null;
  }
  if (window.resets_at) {
    const resetMs = Date.parse(window.resets_at);
    if (Number.isFinite(resetMs) && resetMs <= nowMs) {
      return 0;
    }
  }
  return window.used_percent;
}

function exhaustedWindows(usage: ClaudeAccountUsage, scope: "all" | "fable", nowMs: number): ClaudeUsageWindow[] {
  const windows = [usage.five_hour, usage.seven_day];
  if (scope === "fable") windows.push(usage.fable_weekly);
  // Usage cannot decrease before a window resets, so a 100% observation remains
  // valid until reset even when the observation is stale.
  return windows.filter((window): window is ClaudeUsageWindow =>
    window !== null && (effectiveWindowUsedPercent(window, nowMs) ?? 0) >= 100,
  );
}

export function isUsageExhaustedForScope(usage: ClaudeAccountUsage, scope: "all" | "fable", nowMs: number): boolean {
  return exhaustedWindows(usage, scope, nowMs).length > 0;
}

export function usageExhaustionResetMs(usage: ClaudeAccountUsage, scope: "all" | "fable", nowMs: number): number | null {
  const windows = exhaustedWindows(usage, scope, nowMs);
  if (windows.length === 0) return null;
  const resets = windows.map((window) => window.resets_at ? Date.parse(window.resets_at) : NaN);
  return resets.every(Number.isFinite) ? Math.max(...resets) : null;
}

export function effectiveWindowResetMs(
  window: ClaudeUsageWindow | null | undefined,
  nowMs: number,
): number | null {
  if (!window || typeof window.used_percent !== "number" || !Number.isFinite(window.used_percent)) {
    return null;
  }
  if (!window.resets_at) {
    return null;
  }
  const resetMs = Date.parse(window.resets_at);
  if (!Number.isFinite(resetMs) || resetMs <= nowMs) {
    return null;
  }
  return resetMs;
}

export function relevantWeeklyResetMs(
  usage: ClaudeAccountUsage,
  fableModel: boolean,
  nowMs: number,
): number | null {
  const sevenDayReset = effectiveWindowResetMs(usage.seven_day, nowMs);
  if (!fableModel) {
    return sevenDayReset;
  }
  const fableReset = effectiveWindowResetMs(usage.fable_weekly, nowMs);
  if (sevenDayReset !== null && fableReset !== null) {
    return Math.min(sevenDayReset, fableReset);
  }
  return fableReset ?? sevenDayReset;
}

export function relevantMaxUsedPercent(
  usage: ClaudeAccountUsage,
  fableModel: boolean,
  nowMs: number,
): number | null {
  const values: number[] = [];
  const fiveHour = effectiveWindowUsedPercent(usage.five_hour, nowMs);
  if (fiveHour !== null) {
    values.push(fiveHour);
  }
  const sevenDay = effectiveWindowUsedPercent(usage.seven_day, nowMs);
  if (sevenDay !== null) {
    values.push(sevenDay);
  }
  if (fableModel) {
    const fableWeekly = effectiveWindowUsedPercent(usage.fable_weekly, nowMs);
    if (fableWeekly !== null) {
      values.push(fableWeekly);
    }
  }
  if (values.length === 0) {
    return null;
  }
  return Math.max(...values);
}

export interface SelectableAccountCandidate {
  id: string;
  enabled: boolean;
  priority: number | null;
  auth_state: ClaudeAccountAuthState;
  active_sessions: number;
  stale?: boolean;
  usage: ClaudeAccountUsage;
  blocks?: ClaudeAccountBlocksRecord;
}

export interface SelectCandidateParams {
  candidates: SelectableAccountCandidate[];
  model: string;
  boundAccountId?: string | null;
  boundTurnId?: string | null;
  turnId?: string | null;
  excludeIds?: Iterable<string>;
  nowMs: number;
}

function comparePriority(a: number | null, b: number | null): number {
  const hasA = a !== null && Number.isFinite(a);
  const hasB = b !== null && Number.isFinite(b);
  if (!hasA && !hasB) {
    return 0;
  }
  if (!hasA) {
    return 1;
  }
  if (!hasB) {
    return -1;
  }
  return a - b;
}

function compareOptionalAscending(a: number | null, b: number | null): number {
  const hasA = a !== null && Number.isFinite(a);
  const hasB = b !== null && Number.isFinite(b);
  if (!hasA && !hasB) {
    return 0;
  }
  if (hasA && !hasB) {
    return -1;
  }
  if (!hasA && hasB) {
    return 1;
  }
  return a! - b!;
}

function getEligibleCandidates(params: SelectCandidateParams): SelectableAccountCandidate[] {
  const { candidates, model, nowMs } = params;
  const excludeSet = new Set(params.excludeIds ?? []);
  return candidates.filter((candidate) =>
    candidate.enabled
    && (candidate.auth_state === "ok" || candidate.auth_state === "idle")
    && !excludeSet.has(candidate.id)
    && !isBlockedForModel(candidate.blocks, model, nowMs)
    && !isUsageExhaustedForScope(candidate.usage, isFableModel(model) ? "fable" : "all", nowMs)
  );
}

export function countSelectableCandidates(params: SelectCandidateParams): number {
  return getEligibleCandidates(params).length;
}

/**
 * restricted(격리) 선택에서 자격(접근 토큰) 검사 대상이 되는 후보. 사용량
 * 소진은 자격 축이 아니므로 여기서 빼지 않는다. 자격이 있는 계정이 전부
 * 소진이면 기존 selector가 pool_exhausted를 낸다.
 */
export function getCredentialEligibleCandidates(
  params: SelectCandidateParams,
): SelectableAccountCandidate[] {
  const excludeSet = new Set(params.excludeIds ?? []);
  return params.candidates.filter((candidate) =>
    candidate.enabled
    && (candidate.auth_state === "ok" || candidate.auth_state === "idle")
    && !excludeSet.has(candidate.id)
    && !isBlockedForModel(candidate.blocks, params.model, params.nowMs));
}

export function selectBestCandidate(
  params: SelectCandidateParams,
): SelectableAccountCandidate | null {
  const { model, boundAccountId, boundTurnId, turnId, nowMs } = params;
  const fableModel = isFableModel(model);
  const eligible = getEligibleCandidates(params);

  if (eligible.length === 0) {
    return null;
  }

  // Same-turn idempotency: if the bound account is re-requested on the same turn_id and is still eligible, keep it
  if (boundAccountId && turnId && boundTurnId && turnId === boundTurnId) {
    const sameTurnCandidate = eligible.find((c) => c.id === boundAccountId);
    if (sameTurnCandidate) {
      return sameTurnCandidate;
    }
  }

  const underSoftCap: SelectableAccountCandidate[] = [];
  const atOrAboveSoftCap: SelectableAccountCandidate[] = [];

  for (const candidate of eligible) {
    const maxUsed = candidate.stale
      ? null
      : relevantMaxUsedPercent(candidate.usage, fableModel, nowMs);
    if (maxUsed !== null && maxUsed >= SOFT_USAGE_CAP_PERCENT) {
      atOrAboveSoftCap.push(candidate);
    } else {
      underSoftCap.push(candidate);
    }
  }

  if (underSoftCap.length > 0) {
    underSoftCap.sort((a, b) => {
      // 1. Session affinity
      const affA = boundAccountId && a.id === boundAccountId ? 0 : 1;
      const affB = boundAccountId && b.id === boundAccountId ? 0 : 1;
      if (affA !== affB) {
        return affA - affB;
      }

      // 2. Accounts whose auth was confirmed (ok) precede unmeasured idle ones,
      // so a priority number cannot put an unverified account ahead of a verified one
      const authA = a.auth_state === "ok" ? 0 : 1;
      const authB = b.auth_state === "ok" ? 0 : 1;
      if (authA !== authB) {
        return authA - authB;
      }

      // 3. Priority (smaller number first; null is auto/last)
      const priDiff = comparePriority(a.priority, b.priority);
      if (priDiff !== 0) {
        return priDiff;
      }

      // 4. Measured <98% observations precede unmeasured idle/stale candidates
      const maxA = a.stale ? null : relevantMaxUsedPercent(a.usage, fableModel, nowMs);
      const maxB = b.stale ? null : relevantMaxUsedPercent(b.usage, fableModel, nowMs);
      const measuredA = maxA !== null ? 0 : 1;
      const measuredB = maxB !== null ? 0 : 1;
      if (measuredA !== measuredB) {
        return measuredA - measuredB;
      }

      // 5. Earliest relevant weekly reset first
      const weeklyResetA = a.stale ? null : relevantWeeklyResetMs(a.usage, fableModel, nowMs);
      const weeklyResetB = b.stale ? null : relevantWeeklyResetMs(b.usage, fableModel, nowMs);
      const weeklyResetDiff = compareOptionalAscending(weeklyResetA, weeklyResetB);
      if (weeklyResetDiff !== 0) {
        return weeklyResetDiff;
      }

      // 6. Earliest 5-hour reset first
      const fiveHourResetA = a.stale ? null : effectiveWindowResetMs(a.usage.five_hour, nowMs);
      const fiveHourResetB = b.stale ? null : effectiveWindowResetMs(b.usage.five_hour, nowMs);
      const fiveHourResetDiff = compareOptionalAscending(fiveHourResetA, fiveHourResetB);
      if (fiveHourResetDiff !== 0) {
        return fiveHourResetDiff;
      }

      // 7. For non-Fable models: prefer higher active Fable usage first to preserve Fable headroom
      if (!fableModel) {
        const fableA = a.stale
          ? -1
          : (effectiveWindowUsedPercent(a.usage.fable_weekly, nowMs) ?? -1);
        const fableB = b.stale
          ? -1
          : (effectiveWindowUsedPercent(b.usage.fable_weekly, nowMs) ?? -1);
        if (fableA !== fableB) {
          return fableB - fableA;
        }
      }

      // 8. Lower relevant max usage first as a remaining tie-breaker
      const usageDiff = compareOptionalAscending(maxA, maxB);
      if (usageDiff !== 0) {
        return usageDiff;
      }

      // 9. Fewer active_sessions
      if (a.active_sessions !== b.active_sessions) {
        return a.active_sessions - b.active_sessions;
      }

      // 10. id ascending
      return a.id.localeCompare(b.id);
    });

    return underSoftCap[0] ?? null;
  }

  // All candidates are >= 98% (and not rejected/blocked): pick the one with the most headroom (lowest max usage)
  atOrAboveSoftCap.sort((a, b) => {
    const maxA = relevantMaxUsedPercent(a.usage, fableModel, nowMs) ?? 100;
    const maxB = relevantMaxUsedPercent(b.usage, fableModel, nowMs) ?? 100;
    if (maxA !== maxB) {
      return maxA - maxB;
    }

    const affA = boundAccountId && a.id === boundAccountId ? 0 : 1;
    const affB = boundAccountId && b.id === boundAccountId ? 0 : 1;
    if (affA !== affB) {
      return affA - affB;
    }

    const priDiff = comparePriority(a.priority, b.priority);
    if (priDiff !== 0) {
      return priDiff;
    }

    if (!fableModel) {
      const fableA = effectiveWindowUsedPercent(a.usage.fable_weekly, nowMs) ?? -1;
      const fableB = effectiveWindowUsedPercent(b.usage.fable_weekly, nowMs) ?? -1;
      if (fableA !== fableB) {
        return fableB - fableA;
      }
    }

    if (a.active_sessions !== b.active_sessions) {
      return a.active_sessions - b.active_sessions;
    }

    return a.id.localeCompare(b.id);
  });

  return atOrAboveSoftCap[0] ?? null;
}
