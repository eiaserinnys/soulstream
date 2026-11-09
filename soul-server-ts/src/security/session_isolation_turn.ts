import type {
  ExecutionSecurityDecision,
  ExecutionTier,
} from "./session_isolation_contract.js";

/**
 * 턴 경로가 쓰는 격리 판정 포트. `SESSION_ISOLATION_MODE=off`면 이 객체
 * 자체가 주입되지 않아 판정 호출이 0회다. enforce일 때만 CLI 세션 턴마다
 * 정확히 한 번 호출된다.
 */
export interface SessionIsolationTurnGate {
  /** `TaskManager.resolveExecutionSecurity` 위임. LLM 세션은 호출부가 거른다. */
  resolveDecision(
    sessionId: string,
    effectiveTurnPreset: string | null,
  ): Promise<ExecutionSecurityDecision | null>;
  /** 유효 정책 digest. restricted 실행·재사용 판정의 단일 기준이다. */
  policyDigest(): string;
  /**
   * 이 세션이 이번 턴에 실제로 mount하는 worktree id 전체. prepare가 기록하는
   * child config 값과 같은 수집 함수에서 나온다. full 턴은 호출하지 않는다.
   */
  worktreeAttachmentIds(
    sessionId: string,
    taskWorktreeId: string | undefined,
  ): Promise<readonly string[]>;
}

/**
 * 러너 프로세스가 어떤 보안 조건으로 떠 있는지. 재사용 판정은 이 값이
 * 이번 턴의 요구와 완전히 같을 때만 허용한다.
 */
export interface RunnerIsolationIdentity {
  tier: ExecutionTier;
  /** full 러너는 null. restricted 러너는 유효 정책 digest. */
  policyDigest: string | null;
  /** 부착 워크트리 id의 정렬된 집합. full 러너는 빈 배열. */
  attachedWorktreeIds: readonly string[];
}

export function fullRunnerIsolation(): RunnerIsolationIdentity {
  return { tier: "full", policyDigest: null, attachedWorktreeIds: [] };
}

export function desiredRunnerIsolation(
  decision: ExecutionSecurityDecision | null | undefined,
  policyDigest: string,
  attachedWorktreeIds: readonly string[],
): RunnerIsolationIdentity {
  if (decision?.tier !== "restricted") return fullRunnerIsolation();
  return {
    tier: "restricted",
    policyDigest,
    attachedWorktreeIds: [...attachedWorktreeIds].sort(),
  };
}

/**
 * 보관된 러너를 이번 턴에 그대로 쓸 수 있는지. tier, 정책 digest, 부착
 * 워크트리 집합이 모두 같아야 한다. full→restricted나 restricted→full
 * 재사용은 없다.
 */
export function runnerIsolationAllowsReuse(
  existing: RunnerIsolationIdentity | undefined,
  desired: RunnerIsolationIdentity,
): boolean {
  if (!existing) return desired.tier === "full";
  if (existing.tier !== desired.tier) return false;
  if (desired.tier === "full") return true;
  if (existing.policyDigest !== desired.policyDigest) return false;
  return sameStringSet(existing.attachedWorktreeIds, desired.attachedWorktreeIds);
}

function sameStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}
