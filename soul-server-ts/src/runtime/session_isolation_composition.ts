import type { Env } from "../config.js";
import {
  createSessionIsolationRuntime,
  sessionIsolationSettingsFromEnv,
  type SessionIsolationRuntime,
} from "../security/session_isolation_runtime.js";

export interface SessionIsolationComposition {
  /** restricted 판정과 정책 digest의 유일한 원천. */
  runtime: SessionIsolationRuntime;
}

/**
 * 격리 조립은 이 함수 한 곳에서만 한다. `SESSION_ISOLATION_MODE=off`면
 * undefined이고, 이때 판정 호출과 정책 파일 읽기는 0회다.
 */
export function composeSessionIsolation(
  env: Env,
): SessionIsolationComposition | undefined {
  if (env.SESSION_ISOLATION_MODE === "off") return undefined;
  return {
    runtime: createSessionIsolationRuntime({
      nodeId: env.SOULSTREAM_NODE_ID,
      settings: sessionIsolationSettingsFromEnv(env),
    }),
  };
}
