import type {
  SessionExecutionChain,
  SessionExecutionChainRow,
} from "../db/session_db_types.js";
import type {
  ExecutionSecurityDecision,
} from "./session_isolation_contract.js";

/** 정책·분류·호출자 계보 조회가 실패해 턴을 진행할 수 없을 때의 오류 코드. */
export const ISOLATION_POLICY_UNAVAILABLE = "ISOLATION_POLICY_UNAVAILABLE";

export class IsolationPolicyUnavailableError extends Error {
  readonly code = ISOLATION_POLICY_UNAVAILABLE;

  /**
   * The turn failure path stores only `message` as the terminal detail and the
   * delivery's last error, so the failed read travels inside it. Without it a
   * host timeout and a broken catalog leave the same opaque line.
   */
  constructor(
    readonly sessionId: string,
    readonly cause?: unknown,
  ) {
    const reason = describeFailureChain(cause);
    super(
      reason
        ? `Isolation policy unavailable for session ${sessionId}: ${reason}`
        : `Isolation policy unavailable for session ${sessionId}`,
    );
    this.name = "IsolationPolicyUnavailableError";
  }
}

const FAILURE_CHAIN_MAX_DEPTH = 6;
const FAILURE_CHAIN_MAX_CHARS = 400;

/**
 * `a: b: c` from an error and its `cause` links, skipping a link whose message
 * already appears in the previous one. Bounded in depth and length.
 */
export function describeFailureChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < FAILURE_CHAIN_MAX_DEPTH && current != null; depth += 1) {
    const message = (current instanceof Error ? current.message : String(current)).trim();
    const previous = parts.at(-1);
    if (message && (previous === undefined || !previous.includes(message))) {
      parts.push(message);
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  const joined = parts.join(": ");
  return joined.length > FAILURE_CHAIN_MAX_CHARS
    ? `${joined.slice(0, FAILURE_CHAIN_MAX_CHARS - 1)}…`
    : joined;
}

/**
 * 판정에 필요한 외부 읽기를 주입받는다. 실제 DB·카탈로그·노드 프로필은
 * 호출자(`TaskManager`)가 붙이고, 이 모듈은 순수 판정만 한다.
 */
export interface ExecutionSecurityPolicyPorts {
  platform: NodeJS.Platform;
  /** 한 번의 host 읽기로 가져온 세션 자신과 호출자 계보(가까운 순). */
  readSession(sessionId: string): Promise<SessionExecutionChain>;
  /** 에이전트 프로필의 기본 프리셋. 없으면 null. */
  readNodePreset(agentId: string | null): string | null;
  /** 카탈로그에서 해당 프리셋이 literal boolean true로 표시됐는지. 미등록은 false. */
  isTrustedPreset(presetId: string): boolean;
}

/**
 * 실행 보안 판정(§1).
 *
 * `isolated(s) = linux(s) && (trusted(effectiveTurnPreset(s)) !== true || isolated(caller(s)))`
 *
 * Windows는 격리 대상이 아니다. 호출자 계보는 한 번의 읽기로 가져오며,
 * 마지막 행이 비어 있지 않은 `caller_session_id`를 가진 채 다음 행이 없으면
 * (행 누락·순환·깊이 상한 절단) 해석 불가로 보고 제한한다.
 */
export async function resolveExecutionSecurityDecision(
  sessionId: string,
  effectiveTurnPreset: string | null | undefined,
  ports: ExecutionSecurityPolicyPorts,
): Promise<ExecutionSecurityDecision> {
  const presetId = effectiveTurnPreset ?? null;
  if (ports.platform === "win32") {
    return {
      sessionId,
      tier: "full",
      policyVersion: 1,
      reason: "windows",
      presetId,
    };
  }

  const trustCache = new Map<string, boolean>();
  const isTrusted = (candidate: string | null): boolean => {
    if (candidate === null) return false;
    const cached = trustCache.get(candidate);
    if (cached !== undefined) return cached;
    const trusted = ports.isTrustedPreset(candidate) === true;
    trustCache.set(candidate, trusted);
    return trusted;
  };

  try {
    if (!isTrusted(presetId)) {
      return {
        sessionId,
        tier: "restricted",
        policyVersion: 1,
        reason: "untrusted-preset",
        presetId,
      };
    }

    const chain = await ports.readSession(sessionId);
    if (chain.root === null) {
      return {
        sessionId,
        tier: "restricted",
        policyVersion: 1,
        reason: "unresolved-ancestry",
        presetId,
      };
    }

    const seen = new Set<string>([sessionId]);
    let callerId = chain.root.caller_session_id;
    let cursor = 0;
    while (callerId !== null) {
      const row: SessionExecutionChainRow | undefined = chain.ancestors[cursor];
      if (row === undefined || row.session_id !== callerId || seen.has(row.session_id)) {
        return {
          sessionId,
          tier: "restricted",
          policyVersion: 1,
          reason: "unresolved-ancestry",
          presetId,
        };
      }
      seen.add(row.session_id);
      const legacyModelSelectsNoPreset = row.model_preset === null && row.model !== null;
      const ancestorPreset = row.model_preset
        ?? (legacyModelSelectsNoPreset ? null : ports.readNodePreset(row.agent_id));
      if (!isTrusted(ancestorPreset)) {
        return {
          sessionId,
          tier: "restricted",
          policyVersion: 1,
          reason: "inherited",
          presetId,
        };
      }
      callerId = row.caller_session_id;
      cursor += 1;
    }

    return {
      sessionId,
      tier: "full",
      policyVersion: 1,
      reason: "trusted",
      presetId,
    };
  } catch (error) {
    throw new IsolationPolicyUnavailableError(sessionId, error);
  }
}
