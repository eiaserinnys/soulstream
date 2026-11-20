import {
  countSelectableCandidates,
  type SelectCandidateParams,
  type SelectableAccountCandidate,
} from "./selector.js";
import type { CollectAccountUsageInput } from "./usage.js";

/**
 * select가 「관측 없음」 로컬 계정의 측정을 기다리는 상한(카드 #1734).
 * 재시작 직후 로컬 사용량 관측이 비어 로컬이 idle로 보이고, 늘 ok인 중앙이 ok>idle 규칙으로
 * 이기던 빈틈을 메운다. 턴 시작을 오래 붙잡지 않도록 짧게 둔다. 상한을 넘기면 그 턴은
 * 지금 상태로 고르고, 측정은 계속 돌아 다음 선택부터 로컬이 이긴다.
 */
export const UNMEASURED_LOCAL_USAGE_WAIT_MS = 2_000;

export interface UnmeasuredLocalWaitParams extends SelectCandidateParams {
  /** 자격이 유효한데 아직 한 번도 재지 않은 로컬 계정 id. */
  unmeasuredLocalIds: ReadonlySet<string>;
  profileDir(accountId: string): string;
}

/**
 * select가 기다릴 로컬 측정 대상. 적격 필터(꺼짐, needs_relogin, logging_in, exclude, 모델 범위 차단)를
 * 통과한 「관측 없음」 로컬만 고른다. 중앙에 같은 id가 있어 가려진 사본은 후보에 없으니 빠진다.
 * 같은 턴 다시 고르기에서 묶인 계정이 적격이면 selector가 그 계정을 그대로 쓰므로 기다리지 않는다.
 */
export function unmeasuredLocalWaitTargets(
  params: UnmeasuredLocalWaitParams,
): CollectAccountUsageInput[] {
  const selectable = (candidate: SelectableAccountCandidate): boolean =>
    countSelectableCandidates({ ...params, candidates: [candidate] }) > 0;

  const { boundAccountId, boundTurnId, turnId } = params;
  if (boundAccountId && turnId && boundTurnId === turnId) {
    const bound = params.candidates.find((candidate) => candidate.id === boundAccountId);
    if (bound && selectable(bound)) return [];
  }

  return params.candidates
    .filter((candidate) => params.unmeasuredLocalIds.has(candidate.id) && selectable(candidate))
    .map((candidate) => ({
      accountId: candidate.id,
      profileDir: params.profileDir(candidate.id),
    }));
}

/** work가 끝나거나 limitMs가 지나면 돌아온다. 상한에 걸려도 work는 멈추지 않는다. */
export async function waitAtMost(work: Promise<unknown>, limitMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, limitMs);
  });
  try {
    await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
  }
}
