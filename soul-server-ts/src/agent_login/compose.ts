import { homedir } from "node:os";
import { join } from "node:path";

import { resolveAntigravityCliPath, resolveCodexCliPath } from "@soulstream/executable-path";
import type { Logger } from "pino";

import { buildSanitizedCliEnv } from "../claude_accounts/login_cli_helpers.js";
import { antigravityEnvironment } from "../engine/antigravity_env.js";
import type { ProviderLimits } from "../auth/provider_limits.js";
import type { AgentLoginActivity } from "./activity.js";
import { createAntigravityDriver, findScriptExecutable } from "./antigravity_driver.js";
import { createCodexDriver } from "./codex_driver.js";
import { AgentLoginService } from "./service.js";
import type { AgentLoginProvider, AgentLoginTimings } from "./types.js";

export interface ComposeAgentLoginInput {
  logger: Logger;
  activity?: AgentLoginActivity;
  /** 워커와 같은 환경(HOME 포함). */
  env?: NodeJS.ProcessEnv;
  /** CODEX_CLI_PATH 설정값. */
  codexCliPath?: string;
  /** 시험에서 제한 시간을 줄일 때만 쓴다. */
  timings?: Partial<AgentLoginTimings>;
  /** 그 공급자의 사용량 확인을 한 번 돌린 결과. */
  fetchUsage: (provider: AgentLoginProvider) => Promise<Pick<ProviderLimits, "status">>;
}

/** 로그인 CLI에는 Claude 자격과 API 경로 환경을 넘기지 않는다. HOME은 워커와 같다. */
function loginCliEnv(base: NodeJS.ProcessEnv, extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = buildSanitizedCliEnv(base, "");
  // buildSanitizedCliEnv는 Claude 설정 폴더를 덮어쓰는데, 이 CLI들에는 상관이 없으므로 워커 값을 그대로 둔다.
  if (base.CLAUDE_CONFIG_DIR === undefined) delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = base.CLAUDE_CONFIG_DIR;
  return { ...env, ...extra };
}

/**
 * `fetchUsage`는 로그인이 끝난 뒤에야 불리므로, 사용량 서비스보다 먼저 만들고 나중에 만든 사용량 서비스를 가리켜도 된다.
 * 사용량 서비스는 `service.activity`로 agy 로그인 진행 여부를 읽는다.
 *
 * CLI 경로는 시작할 때마다 다시 찾는다(워커가 뜬 뒤에 설치한 CLI도 쓸 수 있게).
 * 서비스는 항상 만들고, 노드가 이 기능을 알리는지는 등록 능력(agent_login_v1)이 정한다.
 */
export function composeAgentLoginService(input: ComposeAgentLoginInput): AgentLoginService {
  const env = input.env ?? process.env;
  const verifyUsage = (provider: AgentLoginProvider) => async () =>
    (await input.fetchUsage(provider)).status === "auto";
  return new AgentLoginService({
    logger: input.logger,
    activity: input.activity,
    timings: input.timings,
    drivers: {
      codex: createCodexDriver({
        resolveCliPath: () => resolveCodexCliPath(input.codexCliPath, env)?.path,
        buildEnv: () => loginCliEnv(env, {}),
        authFilePath: () => join(env.CODEX_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".codex"), "auth.json"),
        verifyUsage: verifyUsage("codex"),
      }),
      antigravity: createAntigravityDriver({
        resolveCliPath: () => resolveAntigravityCliPath(null, env)?.path,
        resolveScriptPath: () => findScriptExecutable(env, process.platform),
        buildEnv: () => loginCliEnv(antigravityEnvironment(env), { TERM: "xterm-256color" }),
        verifyUsage: verifyUsage("antigravity"),
      }),
    },
  });
}
