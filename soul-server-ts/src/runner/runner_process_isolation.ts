import type { AgentProfile } from "../agent_registry.js";
import type { BackendId } from "../engine/protocol.js";
import type {
  IsolationBackend,
  PreparedIsolationPlan,
} from "../security/session_isolation_contract.js";
import type { Task } from "../task/task_models.js";

import {
  RESTRICTED_ENV_REMOVED_KEYS,
  buildRestrictedSessionEnv,
} from "./session_env.js";
import { SessionIsolationUnavailableError } from "./session_filesystem_errors.js";
import type { RunnerIsolationChildConfig } from "./runner_isolation_config.js";

/** B1·B2가 쓰는 실행 파일 경로. 모두 절대 경로다. */
export interface IsolationToolPaths {
  bwrap: string;
  pasta: string;
  unshare: string;
  setpriv: string;
  nft: string;
  netnsHelper: string;
}

/** 호스트가 이번 러너를 위해 한 번 준비한 결과. 비밀은 `plan.env`에만 있다. */
export interface PreparedRunnerIsolation {
  plan: PreparedIsolationPlan;
  wsl: boolean;
  tools: IsolationToolPaths;
}

export interface RunnerIsolationPreparationRequest {
  task: Task;
  agent: AgentProfile;
  backend: BackendId;
}

/**
 * restricted 러너 준비 경로. 이 객체가 팩토리에 주입될 때만
 * `isolationSupported`가 true가 된다.
 */
export interface RunnerIsolationHost {
  prepare(request: RunnerIsolationPreparationRequest): Promise<PreparedRunnerIsolation>;
}

/** restricted 실행을 실제로 지원하는 백엔드만 통과시킨다. */
export function restrictedIsolationBackend(backend: BackendId): IsolationBackend {
  if (backend === "claude" || backend === "codex" || backend === "opencode") {
    return backend;
  }
  throw new SessionIsolationUnavailableError(
    `SESSION_ISOLATION_UNAVAILABLE: backend ${backend} has no isolated runner path`,
  );
}

/** base 환경에서 host full 관리 자격 값을 모은다. 값은 오류 메시지에 넣지 않는다. */
export function fullManagementSecrets(
  baseEnv: Readonly<Record<string, string | undefined>>,
): string[] {
  const secrets: string[] = [];
  for (const key of RESTRICTED_ENV_REMOVED_KEYS) {
    const value = baseEnv[key];
    if (typeof value === "string" && value.length > 0) secrets.push(value);
  }
  return secrets;
}

/** restricted 러너 자식 프로세스 환경. host full 관리 자격은 여기서 끝난다. */
export function buildRestrictedRunnerChildEnv(input: {
  baseEnv: Readonly<Record<string, string | undefined>>;
  plan: PreparedIsolationPlan;
  wsl: boolean;
}): NodeJS.ProcessEnv {
  const restrictedCredential = input.plan.env.AUTH_BEARER_TOKEN;
  if (!restrictedCredential) {
    throw new SessionIsolationUnavailableError(
      "SESSION_ISOLATION_UNAVAILABLE: prepared isolation plan is missing its restricted credential",
    );
  }
  return buildRestrictedSessionEnv({
    baseEnv: input.baseEnv,
    additions: input.plan.env,
    restrictedCredential,
    fullSecrets: fullManagementSecrets(input.baseEnv),
    wsl: input.wsl,
  });
}

/** 부모가 자식에게 넘기는 격리 설정. 비밀값은 담지 않는다. */
export function isolationChildConfigFromPlan(input: {
  plan: PreparedIsolationPlan;
  tools: IsolationToolPaths;
  wsl: boolean;
  attachedWorktreeIds: readonly string[];
}): RunnerIsolationChildConfig {
  return {
    spec: input.plan.spec,
    resolvConfPath: input.plan.resolvConfPath,
    wsl: input.wsl,
    tools: input.tools,
    envKeys: Object.keys(input.plan.env).sort(),
    contextNotice: input.plan.contextNotice,
    attachedWorktreeIds: [...new Set(input.attachedWorktreeIds)].sort(),
  };
}
