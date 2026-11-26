import type {
  ClaudeAccountBlocked,
  ClaudeAccountUsage,
} from "@soulstream/wire-schema";
import {
  effectiveWindowResetMs,
  effectiveWindowUsedPercent,
  isUsageExhaustedForScope,
} from "@soulstream/wire-schema/claude-account-usage";
import type {
  ClaudeAccountAuthState,
  ClaudeAccountBlocksRecord,
  ClaudeAccountSource,
  ClaudeScopeBlockEntry,
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
): ClaudeAccountBlocked | null {
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
  /** 계정의 출처. 칸이 없으면 노드 로컬 계정으로 본다. */
  source?: ClaudeAccountSource;
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

/**
 * 98% 미만 층 정렬에서 affinity로 볼 계정 id. 묶인 계정이 중앙이고 이 층에 인증 ok인
 * 로컬 후보가 있으면 affinity를 보지 않는다(null). 그 밖에는 묶인 계정 그대로다.
 */
function underCapAffinityAccountId(
  underSoftCap: SelectableAccountCandidate[],
  boundAccountId: string | null | undefined,
): string | null {
  if (!boundAccountId) {
    return null;
  }
  const bound = underSoftCap.find((candidate) => candidate.id === boundAccountId);
  const hasOkLocal = underSoftCap.some(
    (candidate) => candidate.source !== "central" && candidate.auth_state === "ok",
  );
  return bound?.source === "central" && hasOkLocal ? null : boundAccountId;
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

  // 선택 순서 (카드 #1734에서 「로컬 먼저」와 중앙 affinity 예외를 더함)
  // 0. 적격 필터: 꺼짐, ok와 idle이 아닌 인증 상태(needs_relogin, logging_in), exclude된 id,
  //    모델 범위의 차단, 사용량 소진은 후보에서 뺀다. 같은 턴 다시 고르기에서 묶인 계정이
  //    아직 적격이면 정렬 없이 그 계정을 그대로 쓴다.
  // 98% 미만 층(측정값이 98% 미만이거나 재지 못한 후보)이 하나라도 있으면 그 층에서 고른다.
  //   1. 세션 affinity: 세션에 묶인 계정이 맨 앞이다. 로컬에 묶인 세션은 다른 로컬의 priority가
  //      더 앞이어도 그 로컬을 이어 간다.
  //      예외: 묶인 계정이 중앙이고 이 층에 인증 ok인 로컬 후보가 하나라도 있으면 affinity를 보지
  //      않는다(묶인 계정이 없는 것처럼 고른다). 로컬이 98%에 닿거나 막혀 중앙으로 넘어간 세션은
  //      바인딩이 중앙으로 덮어써지므로, 이 예외가 없으면 로컬 한도가 풀린 뒤에도 그 세션이 중앙을
  //      계속 쓴다. 로컬이 다시 쓸 수 있게 되면 다음 턴부터 로컬로 돌아오게 한다. 이 층에 ok 로컬이
  //      없으면(로컬이 모두 idle이거나, 98% 이상이거나, 막혀 빠졌으면) 중앙에 묶인 세션은 그 중앙을
  //      다른 중앙보다 먼저 쓴다.
  //      묶인 중앙이 아직 적격인 같은 턴 다시 고르기는 0번에서 끝나므로 이 예외를 타지 않는다.
  //   2. 인증 ok가 idle보다 먼저: idle은 사용량을 재지 못한 상태(자격 없음, 만료, 사용량 조회
  //      401/403, 캐시 없음)다.
  //   3. 로컬이 중앙보다 먼저: 노드 로컬 계정을 먼저 쓰고, 다 쓰면 중앙 풀로 넘어간다.
  //      ok>idle 뒤에 두는 까닭은 중앙 후보가 늘 ok라서, idle 로컬이 쓸 수 있는 중앙을 이기지
  //      않게 하려는 것이다. 인증은 ok인데 마지막 사용량 조회만 실패한(stale) 로컬은 ok로 남아
  //      로컬 먼저를 탄다. 이 층에서는 로컬과 중앙의 priority를 서로 견주지 않는다.
  //   4. 같은 출처 안에서 priority 오름차순(null은 맨 뒤).
  //   5. 측정값이 있는 후보가 재지 못한 후보보다 먼저.
  //   6. 주간 리셋이 이른 순, 7. 5시간 리셋이 이른 순.
  //   8. Fable이 아닌 모델이면 Fable 사용률이 높은 계정 먼저(Fable 여유를 아낀다).
  //   9. 최대 사용률이 낮은 순, 10. active_sessions가 적은 순, 11. id 오름차순.
  // 98% 미만 층이 비면 98% 이상 층에서 최대 사용률이 낮은 순으로 고른다. 이 층은 출처를 보지
  // 않는다(사용률, affinity, priority, Fable, active_sessions, id 순).
  // 로컬이 98%에 닿거나 막히거나 exclude되면 위 규칙대로 중앙이 골라진다. 로컬이 풀리면 다음
  // 선택에서 로컬이 다시 이긴다. 이미 중앙에 묶인 세션도 1번의 예외로 다음 턴에 돌아온다.
  if (underSoftCap.length > 0) {
    const affinityAccountId = underCapAffinityAccountId(underSoftCap, boundAccountId);
    underSoftCap.sort((a, b) => {
      // 1. Session affinity (중앙 affinity 예외는 underCapAffinityAccountId)
      const affA = affinityAccountId && a.id === affinityAccountId ? 0 : 1;
      const affB = affinityAccountId && b.id === affinityAccountId ? 0 : 1;
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

      // 3. 로컬이 중앙보다 먼저(source 칸이 없으면 로컬)
      const sourceA = a.source === "central" ? 1 : 0;
      const sourceB = b.source === "central" ? 1 : 0;
      if (sourceA !== sourceB) {
        return sourceA - sourceB;
      }

      // 4. Priority within the same source (smaller number first; null is auto/last)
      const priDiff = comparePriority(a.priority, b.priority);
      if (priDiff !== 0) {
        return priDiff;
      }

      // 5. Measured <98% observations precede unmeasured idle/stale candidates
      const maxA = a.stale ? null : relevantMaxUsedPercent(a.usage, fableModel, nowMs);
      const maxB = b.stale ? null : relevantMaxUsedPercent(b.usage, fableModel, nowMs);
      const measuredA = maxA !== null ? 0 : 1;
      const measuredB = maxB !== null ? 0 : 1;
      if (measuredA !== measuredB) {
        return measuredA - measuredB;
      }

      // 6. Earliest relevant weekly reset first
      const weeklyResetA = a.stale ? null : relevantWeeklyResetMs(a.usage, fableModel, nowMs);
      const weeklyResetB = b.stale ? null : relevantWeeklyResetMs(b.usage, fableModel, nowMs);
      const weeklyResetDiff = compareOptionalAscending(weeklyResetA, weeklyResetB);
      if (weeklyResetDiff !== 0) {
        return weeklyResetDiff;
      }

      // 7. Earliest 5-hour reset first
      const fiveHourResetA = a.stale ? null : effectiveWindowResetMs(a.usage.five_hour, nowMs);
      const fiveHourResetB = b.stale ? null : effectiveWindowResetMs(b.usage.five_hour, nowMs);
      const fiveHourResetDiff = compareOptionalAscending(fiveHourResetA, fiveHourResetB);
      if (fiveHourResetDiff !== 0) {
        return fiveHourResetDiff;
      }

      // 8. For non-Fable models: prefer higher active Fable usage first to preserve Fable headroom
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

      // 9. Lower relevant max usage first as a remaining tie-breaker
      const usageDiff = compareOptionalAscending(maxA, maxB);
      if (usageDiff !== 0) {
        return usageDiff;
      }

      // 10. Fewer active_sessions
      if (a.active_sessions !== b.active_sessions) {
        return a.active_sessions - b.active_sessions;
      }

      // 11. id ascending
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
